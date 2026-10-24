package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.storage.CodexStorageActivity;
import com.github.claudecodegui.storage.CodexStorageInventory;
import com.github.claudecodegui.storage.CodexStorageMaintenance;
import com.github.claudecodegui.storage.CodexStoragePaths;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.actions.RevealFileAction;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** Storage settings protocol, independent of the existing directory-migration operation enum. */
final class CodexStorageHandler {
    private static final Logger LOG = Logger.getInstance(CodexStorageHandler.class);
    static final String[] TYPES = {
        "get_ai_storage_usage", "cancel_ai_storage_scan", "list_ai_storage_sessions", "get_ai_storage_session", "reveal_ai_storage_session",
        "get_ai_storage_database_status", "get_ai_storage_mutation_status", "compact_ai_storage_database", "get_ai_storage_maintenance_operation",
        "list_ai_storage_maintenance_operations", "preview_ai_storage_orphans", "clean_ai_storage_orphans", "delete_ai_storage_sessions"
    };
    private final HandlerContext context;
    private final Map<String, AtomicBoolean> scans = new ConcurrentHashMap<>();
    private volatile boolean disposed;

    CodexStorageHandler(HandlerContext context) {
        this.context = context;
    }

    boolean handle(String action, String content) {
        if (!java.util.Arrays.asList(TYPES).contains(action)) {
            return false;
        }
        AppExecutorUtil.getAppExecutorService().execute(() -> execute(action, content));
        return true;
    }

    private void execute(String action, String content) {
        JsonObject response = new JsonObject();
        response.addProperty("action", action);
        try {
            JsonObject request = parse(content);
            String requestId = required(request, "requestId");
            response.addProperty("requestId", requestId);
            if (!"codex".equals(required(request, "provider"))) {
                throw new IOException("PROVIDER_UNSUPPORTED");
            }
            if (disposed || context.isDisposed()) {
                return;
            }
            if (action.equals("cancel_ai_storage_scan")) {
                AtomicBoolean cancelled = scans.get(required(request, "scanId"));
                if (cancelled != null) {
                    cancelled.set(true);
                }
                response.add("data", new JsonObject());
            } else {
                CodexStoragePaths paths = CodexStoragePaths.current();
                CodexStorageMaintenance maintenance = new CodexStorageMaintenance(paths);
                JsonElement data = switch (action) {
                    case "get_ai_storage_database_status" -> maintenance.databaseStatus();
                    case "get_ai_storage_mutation_status" -> mutationStatus(maintenance, context.getSession(), context.getCodexSDKBridge());
                    case "compact_ai_storage_database" -> maintenance.compact(required(request, "databaseId"), required(request, "operationId"));
                    case "preview_ai_storage_orphans" -> maintenance.previewOrphans();
                    case "clean_ai_storage_orphans" -> maintenance.cleanOrphans(required(request, "databaseId"),
                            required(request, "previewToken"), required(request, "operationId"));
                    case "delete_ai_storage_sessions" -> deleteSessions(request, maintenance);
                    case "get_ai_storage_maintenance_operation" -> maintenance.operation(required(request, "operationId"));
                    case "list_ai_storage_maintenance_operations" -> maintenance.operations();
                    default -> read(action, request, paths);
                };
                response.add("data", data);
            }
            response.addProperty("success", true);
        } catch (Exception error) {
            LOG.warn("[CodexStorage] Request failed: " + action, error);
            response.addProperty("success", false);
            response.addProperty("error", CodexStorageMaintenance.errorCode(error));
        }
        if (!disposed && !context.isDisposed() && (context.getProject() == null || !context.getProject().isDisposed())) {
            context.callJavaScript("onCodexStorageResponse", context.escapeJs(response.toString()));
        }
    }

    private JsonObject deleteSessions(JsonObject request, CodexStorageMaintenance maintenance) throws Exception {
        JsonObject status = deleteSessionData(request, maintenance, context.getSession(), context.getCodexSDKBridge());
        if (status.has("result") && status.getAsJsonObject("result").has("deletedSessionIds")) {
            boolean metadataClean = true;
            NodeJsServiceCaller caller = new NodeJsServiceCaller(context);
            for (JsonElement deleted : status.getAsJsonObject("result").getAsJsonArray("deletedSessionIds")) {
                metadataClean &= cleanupSessionMetadata(caller, deleted.getAsString());
            }
            try {
                SessionIndexCache.getInstance().clearAllCodexCache();
                SessionIndexManager.getInstance().clearAllCodexIndex();
            } catch (Exception error) {
                metadataClean = false;
                LOG.warn("[CodexStorage] Failed to clear session indexes", error);
            }
            try {
                status = maintenance.finishMetadata(status.get("operationId").getAsString(), metadataClean);
            } catch (Exception error) {
                LOG.warn("[CodexStorage] Metadata receipt remains pending", error);
            }
        }
        return status;
    }

    static JsonObject deleteSessionData(JsonObject request, CodexStorageMaintenance maintenance,
                                       ClaudeSession session, CodexSDKBridge bridge) throws Exception {
        List<String> ids = deletionTargets(request);
        String operationId = required(request, "operationId");
        try {
            if (!java.util.UUID.fromString(operationId).toString().equals(operationId)) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException error) {
            throw new IOException("INVALID_STORAGE_REQUEST", error);
        }
        requireIdleSession(session, ids);
        boolean history = historyDeletionRequested(request);
        releaseIdleHistorySession(session, ids, bridge).join();
        return history ? maintenance.deleteHistorySessions(ids, operationId, true) : maintenance.deleteSessions(ids, operationId, false, true);
    }

    static JsonObject mutationStatus(CodexStorageMaintenance maintenance, ClaudeSession session, CodexSDKBridge bridge) {
        JsonObject status = maintenance.mutationStatus();
        if (session != null && bridge != null && "codex".equals(session.getProvider()) && session.getSessionId() != null
                && bridge.ownsCodexThread(session.getSessionId()) && !session.isBusy()
                && !session.getState().getExecutionState().hasOwnedPendingWork()) {
            // Our idle target can be unloaded by the delete handler. Unknown owners remain protected.
            status.getAsJsonArray("writerSessionIds").asList().removeIf(id -> id.getAsString().equals(session.getSessionId()));
        }
        return status;
    }

    static boolean historyDeletionRequested(JsonObject request) throws IOException {
        if (!request.has("origin")) {
            return false;
        }
        JsonElement origin = request.get("origin");
        if (!origin.isJsonPrimitive() || !origin.getAsJsonPrimitive().isString()
                || !List.of("history", "storage").contains(origin.getAsString())) {
            throw new IOException("INVALID_STORAGE_REQUEST");
        }
        return origin.getAsString().equals("history");
    }

    static CompletableFuture<Void> releaseIdleHistorySession(ClaudeSession session, Collection<String> ids,
                                                             CodexSDKBridge bridge) throws IOException {
        requireIdleSession(session, ids);
        if (session == null || bridge == null || !"codex".equals(session.getProvider()) || !ids.contains(session.getSessionId())
                || !bridge.ownsCodexThread(session.getSessionId())) {
            return CompletableFuture.completedFuture(null);
        }
        String sessionId = session.getSessionId();
        String channelId = session.getChannelId();
        String cwd = session.getCwd();
        return bridge.releaseIdleCodexThread(channelId, cwd, sessionId).handle((result, failure) -> {
            if (failure != null || result == null || result.has("error")) {
                throw new java.util.concurrent.CompletionException(new IOException("SESSION_RUNNING", failure));
            }
            try {
                if (!java.util.Objects.equals(sessionId, session.getSessionId())
                        || !"codex".equals(session.getProvider()) || !java.util.Objects.equals(channelId, session.getChannelId())) {
                    throw new IOException("SELECTED_DATA_CHANGED");
                }
                requireIdleSession(session, ids);
            } catch (IOException error) {
                throw new java.util.concurrent.CompletionException(error);
            }
            return null;
        });
    }

    static List<String> deletionTargets(JsonObject request) throws IOException {
        JsonElement selected = request.get("sessionIds");
        if (selected == null || !selected.isJsonArray() || selected.getAsJsonArray().isEmpty() || selected.getAsJsonArray().size() > 1000) {
            throw new IOException("INVALID_SESSION_SELECTION");
        }
        List<String> ids = new ArrayList<>();
        for (JsonElement item : selected.getAsJsonArray()) {
            if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()) {
                throw new IOException("INVALID_SESSION_SELECTION");
            }
            String id = item.getAsString();
            CodexStoragePaths.requireSessionId(id);
            ids.add(id);
        }
        return ids;
    }

    static void requireIdleSession(ClaudeSession session, Collection<String> ids) throws IOException {
        if (session != null && "codex".equals(session.getProvider()) && ids.contains(session.getSessionId())
                && (session.isBusy() || session.getState().getExecutionState().hasOwnedPendingWork())) {
            throw new IOException("SESSION_RUNNING");
        }
        if (!java.util.Collections.disjoint(ids, CodexStorageActivity.runningSessionIds())) {
            throw new IOException("SESSION_RUNNING");
        }
    }

    static boolean cleanupSessionMetadata(NodeJsServiceCaller caller, String sessionId) {
        boolean favoritesClean = false;
        boolean titleClean = false;
        try {
            favoritesClean = metadataSucceeded(caller.callNodeJsFavoritesService("removeFavorite", sessionId));
        } catch (Exception error) {
            LOG.warn("[CodexStorage] Failed to clean up session favorite");
        }
        try {
            titleClean = metadataSucceeded(caller.callNodeJsDeleteTitle(sessionId));
        } catch (Exception error) {
            LOG.warn("[CodexStorage] Failed to clean up session title");
        }
        return favoritesClean && titleClean;
    }

    private static boolean metadataSucceeded(String response) {
        JsonElement result = JsonParser.parseString(response);
        JsonElement success = result.isJsonObject() ? result.getAsJsonObject().get("success") : result;
        return success != null && success.isJsonPrimitive() && success.getAsJsonPrimitive().isBoolean() && success.getAsBoolean();
    }

    static Map<String, String> loadSessionTitles(NodeJsServiceCaller caller) {
        try {
            JsonElement result = JsonParser.parseString(caller.callNodeJsTitlesService("loadTitles"));
            if (!result.isJsonObject()) {
                return Map.of();
            }
            Map<String, String> titles = new LinkedHashMap<>();
            for (var entry : result.getAsJsonObject().entrySet()) {
                if (!entry.getValue().isJsonObject()) {
                    continue;
                }
                JsonElement title = entry.getValue().getAsJsonObject().get("customTitle");
                if (title != null && title.isJsonPrimitive() && title.getAsJsonPrimitive().isString() && !title.getAsString().isBlank()) {
                    titles.put(entry.getKey(), title.getAsString());
                }
            }
            return titles;
        } catch (Exception error) {
            if (error instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            LOG.warn("[CodexStorage] Failed to load session titles; using stored history titles");
            return Map.of();
        }
    }

    private JsonObject read(String action, JsonObject request, CodexStoragePaths paths) throws Exception {
        try (AiDataProcessGate.ReadPermit permit = AiDataProcessGate.getInstance().tryAcquireReadPermit()) {
            if (permit == null) {
                throw new IOException("DATABASE_BUSY");
            }
            Map<String, String> titles = "list_ai_storage_sessions".equals(action)
                    ? loadSessionTitles(new NodeJsServiceCaller(context)) : Map.of();
            CodexStorageInventory inventory = new CodexStorageInventory(paths, titles);
            int limit = request.has("limit") ? request.get("limit").getAsInt() : 50;
            return switch (action) {
                case "list_ai_storage_sessions" -> request.has("page")
                        ? inventory.listPage(request.get("page").getAsInt(), limit, optional(request, "query"), optional(request, "sort"), optional(request, "filter"))
                        : inventory.list(optional(request, "cursor"), limit, optional(request, "query"), optional(request, "sort"), optional(request, "filter"));
                case "get_ai_storage_session" -> inventory.content(required(request, "sessionId"), optional(request, "cursor"), limit);
                case "reveal_ai_storage_session" -> revealSession(inventory, paths, required(request, "sessionId"));
                case "get_ai_storage_usage" -> {
                    String requestId = required(request, "requestId");
                    AtomicBoolean cancelled = new AtomicBoolean();
                    if (scans.putIfAbsent(requestId, cancelled) != null) {
                        throw new IOException("REQUEST_ID_CONFLICT");
                    }
                    try {
                        yield inventory.usage(() -> cancelled.get() || disposed || context.isDisposed());
                    } finally {
                        scans.remove(requestId, cancelled);
                    }
                }
                default -> throw new IOException("STORAGE_ACTION_UNSUPPORTED");
            };
        }
    }

    private JsonObject revealSession(CodexStorageInventory inventory, CodexStoragePaths paths, String sessionId) throws IOException {
        Path file = inventory.sessionFile(sessionId);
        CompletableFuture<Void> revealed = new CompletableFuture<>();
        ApplicationManager.getApplication().invokeAndWait(() -> {
            try {
                if (disposed || context.isDisposed() || (context.getProject() != null && context.getProject().isDisposed())
                        || !RevealFileAction.isSupported()) {
                    throw new IOException("STORAGE_LOCATION_UNAVAILABLE");
                }
                paths.revalidate();
                RevealFileAction.openFile(paths.existingFile(file));
                revealed.complete(null);
            } catch (Exception error) {
                revealed.completeExceptionally(error);
            }
        }, ModalityState.any());
        revealed.join();
        JsonObject result = new JsonObject();
        result.addProperty("sessionId", sessionId);
        return result;
    }

    void dispose() {
        disposed = true;
        scans.values().forEach(value -> value.set(true));
    }

    static JsonObject parse(String content) throws IOException {
        try {
            if (content == null || content.length() > 16 * 1024) {
                throw new IllegalArgumentException();
            }
            return JsonParser.parseString(content).getAsJsonObject();
        } catch (RuntimeException error) {
            throw new IOException("INVALID_STORAGE_REQUEST", error);
        }
    }

    static String required(JsonObject request, String name) throws IOException {
        String value = optional(request, name);
        if (value == null || value.isBlank()) {
            throw new IOException("INVALID_STORAGE_REQUEST");
        }
        return value;
    }

    static String optional(JsonObject request, String name) throws IOException {
        if (!request.has(name) || request.get(name).isJsonNull()) {
            return null;
        }
        JsonElement value = request.get(name);
        if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString() || value.getAsString().length() > 1024) {
            throw new IOException("INVALID_STORAGE_REQUEST");
        }
        return value.getAsString();
    }
}
