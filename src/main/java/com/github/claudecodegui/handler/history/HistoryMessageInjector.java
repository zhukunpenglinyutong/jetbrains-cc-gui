package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.handler.UsagePushService;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.provider.codex.CodexNativeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.BooleanSupplier;

/**
 * Service for loading session messages and injecting them into the frontend.
 * Handles both Claude and Codex session loading.
 */
public class HistoryMessageInjector {

    private static final Logger LOG = Logger.getInstance(HistoryMessageInjector.class);
    static final int HISTORY_USER_TURN_LIMIT = 30;
    static final int HISTORY_BATCH_MESSAGE_LIMIT = 50;
    static final int HISTORY_BATCH_TARGET_CHAR_LIMIT = 180_000;
    private static final String CODEX_RECORD_KIND = "_codexRecordKind";
    private static final String EVENT_USER_RECORD = "event_user";
    private static final String RESPONSE_USER_RECORD = "response_user";
    private static final String DUAL_USER_RECORD = "dual_user";

    private final HandlerContext context;
    private final AtomicLong sessionLoadGeneration = new AtomicLong();
    private final CodexHistoryPageIndex codexPageIndex = new CodexHistoryPageIndex();
    private volatile CodexNativeHistoryReader nativeHistoryReader;
    private volatile JsonElement nativeHistoryCursor;

    HistoryMessageInjector(HandlerContext context) {
        this.context = context;
        if (context != null && context.getProject() != null) {
            com.intellij.openapi.util.Disposer.register(context.getProject(), this::invalidateCodexHistory);
        }
    }

    long invalidateCodexHistory() {
        this.nativeHistoryReader = null;
        this.nativeHistoryCursor = null;
        long generation;
        synchronized (sessionLoadGeneration) {
            generation = sessionLoadGeneration.incrementAndGet();
        }
        try {
            codexPageIndex.close();
        } catch (IOException exception) {
            LOG.warn("[HistoryHandler] Failed to clear Codex page index", exception);
        }
        return generation;
    }

    void publishIfCurrent(long generation, Runnable publication) {
        synchronized (sessionLoadGeneration) {
            if (generation == sessionLoadGeneration.get()) {
                publication.run();
            }
        }
    }

    /**
     * Load a history session.
     */
    void handleLoadSession(String sessionId, String currentProvider, HistoryHandler.SessionLoadCallback sessionLoadCallback) {
        // Every session selection invalidates asynchronous Codex loads from the previous selection.
        invalidateCodexHistory();
        String provider = currentProvider;
        String resolvedSessionId = sessionId;
        String model = null;

        try {
            JsonObject payload = new Gson().fromJson(sessionId, JsonObject.class);
            if (payload != null) {
                if (payload.has("sessionId") && !payload.get("sessionId").isJsonNull()) {
                    resolvedSessionId = payload.get("sessionId").getAsString();
                }
                if (payload.has("provider") && !payload.get("provider").isJsonNull()) {
                    provider = payload.get("provider").getAsString();
                }
                if (payload.has("model") && !payload.get("model").isJsonNull()) {
                    String m = payload.get("model").getAsString();
                    if (m != null && !m.trim().isEmpty()) {
                        model = m.trim();
                    }
                }
            }
        } catch (Exception ignored) {
            // Backward compatible: legacy payload is the raw sessionId string.
        }

        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        if (projectPath == null) {
            LOG.warn("[HistoryHandler] Project base path is null");
            notifyHistoryLoadComplete();
            return;
        }
        LOG.info("[HistoryHandler] Loading history session: " + resolvedSessionId
                + " from project: " + projectPath + ", provider: " + provider
                + (model != null ? ", model: " + model : ""));

        if ("codex".equals(provider)) {
            // Codex session: read session info and restore session state
            loadCodexSession(resolvedSessionId, model);
        } else {
            // Claude / CLI providers: use existing callback mechanism
            if (sessionLoadCallback != null) {
                sessionLoadCallback.onLoadSession(resolvedSessionId, projectPath, provider, model);
            } else {
                LOG.warn("[HistoryHandler] WARNING: No session load callback set");
                notifyHistoryLoadComplete();
            }
        }
    }

    /**
     * Load a Codex session.
     * Reads session messages directly and injects them into the frontend, while restoring session state.
     */
    void loadCodexSession(String sessionId) {
        loadCodexSession(sessionId, null);
    }

    void loadCodexSession(String sessionId, String model) {
        long generation = invalidateCodexHistory();
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始加载 Codex 会话 ==========");
            LOG.info("[HistoryHandler] SessionId: " + sessionId);

            try {
                ClaudeSession activeSession = this.context.getSession();
                String oldThread = activeSession == null ? null : activeSession.getSessionId();
                if (activeSession != null && "codex".equals(activeSession.getProvider())
                        && oldThread != null && !oldThread.equals(sessionId) && this.context.getCodexSDKBridge() != null) {
                    // Node bounds the release itself; keep a Java-side ceiling so
                    // this history load can never block on the release forever.
                    JsonObject release = this.context.getCodexSDKBridge().releaseCodexThread(activeSession.getChannelId(),
                            activeSession.getCwd(), oldThread).get(30, java.util.concurrent.TimeUnit.SECONDS);
                    if (release.has("error")) {
                        throw new IllegalStateException(release.get("error").getAsString());
                    }
                }
                CodexHistoryReader codexReader = new CodexHistoryReader();
                CodexHistoryPage page = this.readInitialCodexHistory(codexReader, sessionId, generation);
                publishIfCurrent(generation, () -> {
                    String threadIdToUse = page.threadId != null ? page.threadId : sessionId;
                    String cwd = page.cwd;

                    context.getSession().setSessionInfo(threadIdToUse, cwd);
                    context.getSession().setProvider("codex");
                    this.nativeHistoryReader = page.nativeReader;
                    this.nativeHistoryCursor = page.cursor;
                    if (model != null && !model.isBlank()) {
                        context.getSession().setModel(model.trim());
                    }
                    restoreCodexFrontendMessagesToSessionState(context.getSession().getState(), page.messages);
                    pushRestoredCodexUsage();
                    LOG.info("[HistoryHandler] 恢复 Codex 会话状态: threadId=" + threadIdToUse + " (from sessionId=" + sessionId + "), cwd=" + cwd);

                    injectCodexHistoryPage(sessionId, page, true);

                    notifyHistoryLoadComplete(generation);
                });

                LOG.info("[HistoryHandler] ========== Codex 会话加载完成 ==========");

            } catch (Exception e) {
                if (generation != sessionLoadGeneration.get()) {
                    LOG.info("[HistoryHandler] Ignoring stale Codex session load failure: " + sessionId);
                    return;
                }
                LOG.error("[HistoryHandler] 加载 Codex 会话失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> publishIfCurrent(generation, () -> {
                    String errorMsg = context.escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.addErrorMessage) { " +
                                            "  window.addErrorMessage('加载 Codex 会话失败: " + errorMsg + "'); " +
                                            "}";
                    context.executeJavaScriptQueued(jsCode);
                }));
                notifyHistoryLoadComplete(generation);
            }
        }, CodexSDKBridge.codexControlExecutor());
    }

    private CodexHistoryPage readInitialCodexHistory(CodexHistoryReader legacyReader, String sessionId, long generation) throws Exception {
        // The session may be absent in exactly the scenario loadCodexSession
        // already anticipates; keep the reader usable without a channel id.
        ClaudeSession session = this.context.getSession();
        CodexNativeHistoryReader reader = new CodexNativeHistoryReader(this.context.getCodexSDKBridge(),
                session == null ? null : session.getChannelId(),
                this.context.resolveEffectiveWorkingDirectory(), sessionId);
        if (this.context.getCodexSDKBridge() == null) {
            return this.codexPageIndex.read(legacyReader, sessionId, null, HISTORY_USER_TURN_LIMIT,
                    () -> generation == this.sessionLoadGeneration.get());
        }
        CodexHistoryPage nativePage;
        try {
            nativePage = this.nativeHistoryPage(reader, reader.readPage(null, HISTORY_USER_TURN_LIMIT), null);
        } catch (Exception error) {
            if (!CodexNativeHistoryReader.permitsOfflineFallback(error.getMessage())) {
                throw error;
            }
            return this.codexPageIndex.read(legacyReader, sessionId, null, HISTORY_USER_TURN_LIMIT,
                    () -> generation == this.sessionLoadGeneration.get());
        }
        // Select a complete legacy transcript only when the native projection
        // omits stored tools, their resolved presentation or pre-compaction turns.
        CodexHistoryPage legacyPage;
        try {
            legacyPage = this.codexPageIndex.read(legacyReader, sessionId, null, HISTORY_USER_TURN_LIMIT,
                    () -> generation == this.sessionLoadGeneration.get());
        } catch (IOException unavailable) {
            return nativePage;
        }
        if (requiresLegacyProjection(nativePage, legacyPage)) {
            return legacyPage;
        }
        return nativePage;
    }

    static boolean requiresLegacyProjection(CodexHistoryPage nativePage, CodexHistoryPage legacyPage) {
        long nativeTools = CodexNativeHistoryReader.countBlocks(nativePage.messages, "tool_use");
        long legacyTools = CodexNativeHistoryReader.countBlocks(legacyPage.messages, "tool_use");
        long nativeUsers = nativePage.messages.stream().filter(HistoryMessageInjector::isHumanUserMessage).count();
        boolean missingThinking = CodexNativeHistoryReader.countBlocks(nativePage.messages, "thinking")
                < CodexNativeHistoryReader.countBlocks(legacyPage.messages, "thinking");
        boolean missingUsage = !CodexNativeHistoryReader.hasUsage(nativePage.messages) && CodexNativeHistoryReader.hasUsage(legacyPage.messages);
        boolean missingCompaction = CodexNativeHistoryReader.countCompactions(nativePage.messages)
                < CodexNativeHistoryReader.countCompactions(legacyPage.messages);
        boolean missingCompactionTime = CodexNativeHistoryReader.countTimedCompactions(nativePage.messages)
                < CodexNativeHistoryReader.countTimedCompactions(legacyPage.messages);
        return nativeTools < legacyTools || containsReplayedExec(nativePage, legacyPage)
                || missingThinking || missingUsage || missingCompaction || missingCompactionTime
                || (!nativePage.partial && legacyPage.totalTurns > nativeUsers);
    }

    private static boolean containsReplayedExec(CodexHistoryPage nativePage, CodexHistoryPage legacyPage) {
        Set<String> replayed = new HashSet<>();
        for (JsonObject message : legacyPage.messages) {
            JsonObject raw = message.has("raw") && message.get("raw").isJsonObject() ? message.getAsJsonObject("raw") : null;
            String callId = getStringProperty(raw, "codexReplayedCallId");
            if (callId != null) {
                replayed.add(callId);
            }
        }
        if (replayed.isEmpty()) {
            return false;
        }
        for (JsonObject message : nativePage.messages) {
            JsonObject raw = message.has("raw") && message.get("raw").isJsonObject() ? message.getAsJsonObject("raw") : null;
            if (raw == null) {
                continue;
            }
            JsonObject payload = raw.has("message") && raw.get("message").isJsonObject() ? raw.getAsJsonObject("message") : raw;
            if (!payload.has("content") || !payload.get("content").isJsonArray()) {
                continue;
            }
            for (JsonElement element : payload.getAsJsonArray("content")) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject block = element.getAsJsonObject();
                String name = getStringProperty(block, "name");
                if ("tool_use".equals(getStringProperty(block, "type")) && ("exec".equals(name) || "functions.exec".equals(name))
                        && replayed.contains(getStringProperty(block, "id"))) {
                    return true;
                }
            }
        }
        return false;
    }

    private CodexHistoryPage nativeHistoryPage(CodexNativeHistoryReader reader, CodexNativeHistoryReader.Page nativePage,
                                               JsonElement requestedCursor) {
        CodexHistoryPage page = new CodexHistoryPage();
        page.messages = nativePage.messages();
        page.threadId = getStringProperty(nativePage.thread(), "id");
        page.cwd = getStringProperty(nativePage.thread(), "cwd");
        page.sessionTitle = getStringProperty(nativePage.thread(), "name");
        page.source = "native";
        page.nativeReader = reader;
        page.cursor = nativePage.cursor();
        page.requestCursor = requestedCursor;
        page.partial = nativePage.partial();
        return page;
    }

    void loadEarlierCodexHistoryPage(String content) {
        long generation = sessionLoadGeneration.get();
        CompletableFuture.runAsync(() -> {
            String sessionId = null;
            Integer beforeTurn = null;
            try {
                JsonObject request = new Gson().fromJson(content, JsonObject.class);
                if (request == null || !request.has("sessionId")
                        || (!request.has("beforeTurn") && !request.has("cursor"))) {
                    throw new IllegalArgumentException("Invalid Codex history page request");
                }
                sessionId = request.get("sessionId").getAsString();
                beforeTurn = request.has("beforeTurn") ? request.get("beforeTurn").getAsInt() : null;
                if (sessionId.isBlank() || sessionId.length() > 200 || (beforeTurn != null && beforeTurn < 0)) {
                    throw new IllegalArgumentException("Invalid Codex history page cursor");
                }

                CodexNativeHistoryReader nativeReader = this.nativeHistoryReader;
                CodexHistoryPage page;
                if (nativeReader != null) {
                    JsonElement cursor = request.get("cursor");
                    if (cursor == null || cursor.isJsonNull() || !cursor.equals(this.nativeHistoryCursor)) {
                        throw new IllegalArgumentException("Stale native Codex history cursor");
                    }
                    page = this.nativeHistoryPage(nativeReader, nativeReader.readPage(cursor, HISTORY_USER_TURN_LIMIT), cursor);
                } else {
                    if (beforeTurn == null || request.has("cursor")) {
                        throw new IllegalArgumentException("Legacy Codex history requires its original turn cursor");
                    }
                    page = this.codexPageIndex.read(new CodexHistoryReader(), sessionId, beforeTurn,
                            HISTORY_USER_TURN_LIMIT, () -> generation == this.sessionLoadGeneration.get());
                }
                String requestedSessionId = sessionId;
                publishIfCurrent(generation, () -> {
                    String activeSessionId = context.getSession() != null
                            ? context.getSession().getSessionId() : null;
                    boolean activeSessionMatches = requestedSessionId.equals(activeSessionId)
                            || (page.threadId != null && page.threadId.equals(activeSessionId));
                    if (!activeSessionMatches) {
                        LOG.info("[HistoryHandler] Discarding stale Codex history page: " + requestedSessionId);
                        return;
                    }
                    boolean replace = page.cursorReset;
                    if (replace) {
                        restoreCodexFrontendMessagesToSessionState(context.getSession().getState(), page.messages);
                        pushRestoredCodexUsage();
                    } else {
                        List<ClaudeSession.Message> earlier = new ArrayList<>();
                        for (JsonObject message : page.messages) {
                            ClaudeSession.Message parsed = toSessionMessage(message);
                            if (parsed != null) {
                                earlier.add(parsed);
                            }
                        }
                        SessionState state = this.context.getSession().getState();
                        synchronized (state.getMessageStateLock()) {
                            state.replaceMessages(com.github.claudecodegui.session.CodexHistoryMerger.merge(
                                    earlier, state.getMessages()));
                        }
                    }
                    this.nativeHistoryCursor = page.cursor;
                    injectCodexHistoryPage(requestedSessionId, page, replace);
                    notifyCodexHistoryPageRenderComplete();
                });
            } catch (Exception e) {
                if (generation != sessionLoadGeneration.get()) {
                    return;
                }
                LOG.error("[HistoryHandler] 加载更早 Codex 历史失败: " + e.getMessage(), e);
                String failedSessionId = sessionId;
                Integer failedBeforeTurn = beforeTurn;
                publishIfCurrent(generation, () -> notifyCodexHistoryPageError(failedSessionId, failedBeforeTurn, e.getMessage()));
            }
        }, CodexSDKBridge.codexControlExecutor());
    }

    private void notifyCodexHistoryPageRenderComplete() {
        context.callJavaScript("codexHistoryPageRenderComplete");
    }

    /**
     * Load an earlier page of Claude history and prepend to the current session.
     * Called when the user scrolls to the top of the message list.
     */
    void loadEarlierClaudeHistoryPage(String content) {
        CompletableFuture.runAsync(() -> {
            String sessionId = null;
            Integer beforeTurn = null;
            try {
                JsonObject request = new Gson().fromJson(content, JsonObject.class);
                if (request == null || !request.has("sessionId") || !request.has("beforeTurn")) {
                    throw new IllegalArgumentException("Invalid Claude history page request");
                }
                sessionId = request.get("sessionId").getAsString();
                beforeTurn = request.get("beforeTurn").getAsInt();
                if (sessionId.isBlank() || sessionId.length() > 200 || beforeTurn < 0) {
                    throw new IllegalArgumentException("Invalid Claude history page cursor");
                }

                // Delegate to the session orchestrator which handles the actual pagination
                ClaudeSession session = context.getSession();
                if (session != null && sessionId.equals(session.getSessionId())) {
                    String cwd = context.getProject() != null ? context.getProject().getBasePath() : null;
                    session.getOrchestrator().loadEarlierClaudeHistoryPage(sessionId, cwd, beforeTurn);
                } else {
                    LOG.warn("[HistoryHandler] Claude history page request for inactive session: " + sessionId);
                }
            } catch (Exception e) {
                LOG.error("[HistoryHandler] Failed to load earlier Claude history page: " + e.getMessage(), e);
                notifyClaudeHistoryPageError(sessionId, beforeTurn, e.getMessage());
            }
        });
    }

    private void notifyClaudeHistoryPageError(String sessionId, Integer beforeTurn, String errorMessage) {
        JsonObject error = new JsonObject();
        if (sessionId != null) {
            error.addProperty("sessionId", sessionId);
        }
        if (beforeTurn != null) {
            error.addProperty("beforeTurn", beforeTurn);
        }
        error.addProperty("message", errorMessage != null ? errorMessage : "Unknown error");
        context.callJavaScript("claudeHistoryPageError", context.escapeJs(new Gson().toJson(error)));
    }

    private void pushRestoredCodexUsage() {
        ClaudeSession session = context.getSession();
        if (session == null) {
            return;
        }
        int fallbackMaxTokens = SettingsHandler.getModelContextLimit(
                session.getProvider(), session.getModel());
        new UsagePushService(context).pushCurrentUsageIfAvailable(fallbackMaxTokens);
    }

    static CodexHistoryPage scanCodexHistoryPage(CodexHistoryReader reader,
                                                  String sessionId,
                                                  Integer beforeTurn,
                                                  int pageSize) throws IOException {
        if (pageSize <= 0) {
            throw new IllegalArgumentException("Codex history page size must be positive");
        }

        CodexTurnPageCollector turnCollector = new CodexTurnPageCollector(beforeTurn, pageSize);
        CodexFrontendMessageAccumulator accumulator = new CodexFrontendMessageAccumulator(turnCollector::accept);
        CodexHistoryPage page = new CodexHistoryPage();
        page.rawRecordCount = reader.forEachSessionMessage(sessionId, rawMessage -> {
            extractSessionMeta(rawMessage, page);
            accumulator.accept(rawMessage);
        });
        accumulator.finish();
        turnCollector.finish(page);

        LOG.info("[HistoryHandler] Scanned Codex history records=" + page.rawRecordCount
                + ", totalUserTurns=" + page.totalTurns
                + ", page=[" + page.fromTurn + ", " + page.toTurn + ")"
                + ", messages=" + page.messages.size()
                + ", cursorReset=" + page.cursorReset);
        return page;
    }

    static CodexHistoryPage paginateCodexMessages(JsonArray messages,
                                                   Integer beforeTurn,
                                                   int pageSize) {
        CodexTurnPageCollector turnCollector = new CodexTurnPageCollector(beforeTurn, pageSize);
        CodexFrontendMessageAccumulator accumulator = new CodexFrontendMessageAccumulator(turnCollector::accept);
        CodexHistoryPage page = new CodexHistoryPage();
        page.rawRecordCount = messages.size();
        for (JsonElement element : messages) {
            JsonObject rawMessage = element.getAsJsonObject();
            extractSessionMeta(rawMessage, page);
            accumulator.accept(rawMessage);
        }
        accumulator.finish();
        turnCollector.finish(page);
        return page;
    }

    static CodexHistoryPage scanCodexHistoryPageUncached(CodexHistoryReader reader, String sessionId,
                                                        Integer beforeTurn, int pageSize,
                                                        BooleanSupplier active) throws IOException {
        CodexTurnPageCollector collector = new CodexTurnPageCollector(beforeTurn, pageSize);
        CodexFrontendMessageAccumulator accumulator = new CodexFrontendMessageAccumulator(collector::accept);
        CodexHistoryPage page = new CodexHistoryPage();
        Path file = reader.resolveSessionFile(sessionId);
        long size = Files.size(file);
        page.rawRecordCount = reader.forEachSessionMessage(sessionId, file, 0, size, active, raw -> {
            extractSessionMeta(raw, page);
            accumulator.accept(raw);
        });
        page.sourceBytesRead = size;
        accumulator.finish();
        collector.finish(page);
        return page;
    }

    static void extractSessionMeta(JsonObject rawMessage, CodexHistoryPage page) {
        if (!"session_meta".equals(getStringProperty(rawMessage, "type"))
                || !rawMessage.has("payload") || !rawMessage.get("payload").isJsonObject()) {
            return;
        }
        JsonObject payload = rawMessage.getAsJsonObject("payload");
        if (page.cwd == null) {
            page.cwd = getStringProperty(payload, "cwd");
        }
        if (page.threadId == null) {
            page.threadId = getStringProperty(payload, "id");
        }
    }

    static final class CodexHistoryPage {
        List<JsonObject> messages = new ArrayList<>();
        int fromTurn;
        int toTurn;
        int totalTurns;
        int rawRecordCount;
        long sourceBytesRead;
        boolean cursorReset;
        String threadId;
        String cwd;
        String sessionTitle;
        String source = "legacy";
        JsonElement cursor;
        JsonElement requestCursor;
        boolean partial;
        CodexNativeHistoryReader nativeReader;
    }

    private static final class IndexedTurn {
        private final int index;
        private final List<JsonObject> messages;

        private IndexedTurn(int index, List<JsonObject> messages) {
            this.index = index;
            this.messages = messages;
        }
    }

    private static final class CodexTurnPageCollector {
        private final Integer requestedBeforeTurn;
        private final int pageSize;
        private final int requestedFromTurn;
        private final Deque<IndexedTurn> recentTurns;
        private final List<JsonObject> selectedMessages = new ArrayList<>();
        private List<JsonObject> currentTurn;
        private int currentTurnIndex = -1;
        private int totalTurns;

        private CodexTurnPageCollector(Integer requestedBeforeTurn, int pageSize) {
            this.requestedBeforeTurn = requestedBeforeTurn;
            this.pageSize = pageSize;
            this.requestedFromTurn = requestedBeforeTurn == null
                    ? -1 : Math.max(0, requestedBeforeTurn - pageSize);
            this.recentTurns = new ArrayDeque<>(pageSize);
        }

        private void accept(JsonObject message) {
            if (isHumanUserMessage(message)) {
                finishCurrentTurn();
                currentTurnIndex = totalTurns++;
                currentTurn = new ArrayList<>();
            }
            if (currentTurn != null) {
                currentTurn.add(message);
            }
        }

        private void finish(CodexHistoryPage page) {
            finishCurrentTurn();
            page.totalTurns = totalTurns;

            if (requestedBeforeTurn == null) {
                copyRecentTurns(page);
                return;
            }

            if (requestedBeforeTurn > totalTurns) {
                page.cursorReset = true;
                copyRecentTurns(page);
                return;
            }

            page.fromTurn = requestedFromTurn;
            page.toTurn = requestedBeforeTurn;
            page.messages = new ArrayList<>(selectedMessages);
        }

        private void finishCurrentTurn() {
            if (currentTurn == null) {
                return;
            }

            IndexedTurn completed = new IndexedTurn(currentTurnIndex, currentTurn);
            recentTurns.addLast(completed);
            if (recentTurns.size() > pageSize) {
                recentTurns.removeFirst();
            }
            if (requestedBeforeTurn != null
                    && currentTurnIndex >= requestedFromTurn
                    && currentTurnIndex < requestedBeforeTurn) {
                selectedMessages.addAll(currentTurn);
            }
            currentTurn = null;
        }

        private void copyRecentTurns(CodexHistoryPage page) {
            page.messages = new ArrayList<>();
            for (IndexedTurn turn : recentTurns) {
                page.messages.addAll(turn.messages);
            }
            page.fromTurn = recentTurns.isEmpty() ? 0 : recentTurns.getFirst().index;
            page.toTurn = totalTurns;
        }
    }

    void notifyHistoryLoadComplete() {
        notifyHistoryLoadComplete(sessionLoadGeneration.get());
    }

    private void notifyHistoryLoadComplete(long generation) {
        ApplicationManager.getApplication().invokeLater(() -> publishIfCurrent(generation, () -> {
            String jsCode = "if (window.historyLoadComplete) { " +
                                    "  try { " +
                                    "    window.historyLoadComplete(); " +
                                    "  } catch(e) { " +
                                    "    console.error('[HistoryHandler] historyLoadComplete callback failed:', e); " +
                                    "  } " +
                                    "}";
            context.executeJavaScriptQueued(jsCode);
        }));
    }

    /**
     * 将 Codex 历史消息批量转换为前端消息列表。
     * 只统一前端注入协议，不改变 Codex 历史文件格式与标题数据来源。
     */
    public static List<JsonObject> convertCodexMessagesToFrontendBatch(JsonArray messages) {
        List<JsonObject> frontendMessages = new ArrayList<>();
        CodexFrontendMessageAccumulator accumulator = new CodexFrontendMessageAccumulator(frontendMessages::add);
        for (JsonElement element : messages) {
            if (element.isJsonObject()) {
                accumulator.accept(element.getAsJsonObject());
            }
        }
        accumulator.finish();
        return frontendMessages;
    }

    /**
     * Extracts a provider-reported Codex context snapshot from a JSONL token_count record.
     * Only last_token_usage represents the active model context. Session-cumulative
     * total_token_usage is deliberately ignored because it may exceed the model window.
     */
    private static JsonObject extractCodexTokenCountUsage(JsonObject message) {
        if (message == null
                || !"event_msg".equals(getStringProperty(message, "type"))
                || !message.has("payload")
                || !message.get("payload").isJsonObject()) {
            return null;
        }
        JsonObject payload = message.getAsJsonObject("payload");
        if (!"token_count".equals(getStringProperty(payload, "type"))
                || !payload.has("info")
                || !payload.get("info").isJsonObject()) {
            return null;
        }
        JsonObject info = payload.getAsJsonObject("info");
        if (!info.has("last_token_usage") || !info.get("last_token_usage").isJsonObject()) {
            return null;
        }
        JsonObject contextUsage = info.getAsJsonObject("last_token_usage");

        JsonObject usage = new JsonObject();
        usage.addProperty("input_tokens", getIntProperty(contextUsage, "input_tokens"));
        usage.addProperty("output_tokens", getIntProperty(contextUsage, "output_tokens"));
        usage.addProperty("cache_read_input_tokens", getIntProperty(contextUsage, "cached_input_tokens"));
        usage.addProperty("cache_creation_input_tokens", 0);
        int contextWindow = getIntProperty(info, "model_context_window");
        if (contextWindow > 0) {
            usage.addProperty("model_context_window", contextWindow);
        }
        return usage;
    }

    private static int getIntProperty(JsonObject object, String propertyName) {
        if (object == null || !object.has(propertyName) || object.get(propertyName).isJsonNull()) {
            return 0;
        }
        try {
            return Math.max(0, object.get(propertyName).getAsInt());
        } catch (RuntimeException ignored) {
            return 0;
        }
    }

    private static boolean isInternalHistoryToolCall(JsonObject payload) {
        String payloadType = getStringProperty(payload, "type");
        String toolName = getStringProperty(payload, "name");
        if (payloadType == null || toolName == null) {
            return false;
        }

        if (!"function_call".equals(payloadType) && !"custom_tool_call".equals(payloadType)) {
            return false;
        }
        return CodexMessageConverter.isHiddenHistoryToolName(toolName);
    }

    private static boolean isToolOutputPayload(JsonObject payload) {
        String payloadType = getStringProperty(payload, "type");
        if (payloadType == null) {
            return false;
        }
        return "function_call_output".equals(payloadType) || "custom_tool_call_output".equals(payloadType);
    }

    private static boolean isOutputForInternalHistoryTool(
            JsonObject payload,
            Set<String> internalToolCallIds
    ) {
        String callId = getStringProperty(payload, "call_id");
        if (callId == null) {
            return false;
        }

        return isToolOutputPayload(payload)
            && internalToolCallIds.contains(callId);
    }

    private static JsonObject getResponseItemPayload(JsonObject message) {
        if (message == null
                || !message.has("type")
                || !"response_item".equals(message.get("type").getAsString())
                || !message.has("payload")
                || !message.get("payload").isJsonObject()) {
            return null;
        }
        return message.getAsJsonObject("payload");
    }

    static final class CodexFrontendMessageAccumulator {
        private static final long MAX_REPLAY_BYTES = 8L * 1024 * 1024;
        private final Consumer<JsonObject> consumer;
        private final Consumer<JsonObject> usageUpdated;
        private JsonObject pending;
        private JsonObject latestAssistant;
        private final Map<String, List<CodexExecHistoryReplay.Command>> shellCalls = new HashMap<>();
        private final Set<String> planCalls = new HashSet<>();
        private final Map<String, List<String>> patchCalls = new HashMap<>();
        private long recordNumber;
        private String recordedPatchCallId;
        private final Set<String> recordedPatchItemIds = new HashSet<>();
        private CodexKnownExecReplay knownExec;
        private String rootThreadId;
        private final Map<String, CodexKnownExecReplay.Process> processCalls = new java.util.LinkedHashMap<>();
        private final CodexRecordedImageGeneration.Lifecycle generatedImages = new CodexRecordedImageGeneration.Lifecycle();

        private CodexFrontendMessageAccumulator(Consumer<JsonObject> consumer) {
            this(consumer, message -> { });
        }

        CodexFrontendMessageAccumulator(Consumer<JsonObject> consumer, Consumer<JsonObject> usageUpdated) {
            this.consumer = consumer;
            this.usageUpdated = usageUpdated;
        }

        void accept(JsonObject rawMessage) {
            this.recordNumber++;
            if ("session_meta".equals(getStringProperty(rawMessage, "type"))
                    && rawMessage.has("payload") && rawMessage.get("payload").isJsonObject()) {
                this.rootThreadId = getStringProperty(rawMessage.getAsJsonObject("payload"), "id");
            }
            JsonObject payload = getResponseItemPayload(rawMessage);
            String callId = getStringProperty(payload, "call_id");
            String payloadType = getStringProperty(payload, "type");
            if (this.knownExec != null) {
                if (this.knownExec.rememberNative(rawMessage)) {
                    if (this.retainedBytes() > MAX_REPLAY_BYTES) {
                        this.flushKnownExec(null);
                    }
                    return;
                }
                if (isToolOutputPayload(payload) && this.knownExec.callId().equals(callId)) {
                    this.flushKnownExec(rawMessage);
                    return;
                }
                if ("custom_tool_call".equals(payloadType) || "function_call".equals(payloadType)
                        || "message".equals(payloadType) || "reasoning".equals(payloadType)
                        || "compacted".equals(getStringProperty(rawMessage, "type"))
                        || getCodexUserRecordKind(rawMessage) != null) {
                    this.flushKnownExec(null);
                }
            }
            if ("custom_tool_call".equals(payloadType) || "function_call".equals(payloadType)) {
                CodexKnownExecReplay candidate = CodexKnownExecReplay.begin(rawMessage, this.rootThreadId);
                if (candidate != null && this.retainedBytes() + candidate.retainedBytes() <= MAX_REPLAY_BYTES) {
                    this.emitPending();
                    this.recordedPatchCallId = null;
                    this.recordedPatchItemIds.clear();
                    this.knownExec = candidate;
                    return;
                }
            }
            this.acceptLegacy(rawMessage);
        }

        private void flushKnownExec(JsonObject output) {
            CodexKnownExecReplay replay = this.knownExec;
            this.knownExec = null;
            if (replay == null) {
                return;
            }
            List<JsonObject> messages = null;
            try {
                messages = replay.project(output, this.processCalls);
            } catch (RuntimeException ignored) {
                // Malformed independent results cannot establish a complete replacement.
            }
            if (messages != null) {
                messages.forEach(this::acceptConverted);
                return;
            }
            if (replay.keepsOriginalWrapper()) {
                // A rejected ownership/index mapping must not be retried by looser legacy heuristics.
                this.acceptOpaqueExecRecord(replay.original(), replay.callId(), false);
                for (JsonObject record : replay.nativeRecords()) {
                    List<JsonObject> changes = CodexRecordedFileChange.readMessages(record);
                    if (changes.isEmpty()) {
                        this.acceptLegacy(record);
                    } else {
                        changes.forEach(this::acceptConverted);
                    }
                }
                if (output != null) {
                    this.acceptOpaqueExecRecord(output, replay.callId(), true);
                }
                return;
            }
            this.acceptLegacy(replay.original());
            replay.nativeRecords().forEach(this::acceptLegacy);
            if (output != null) {
                this.acceptLegacy(output);
            }
        }

        private void acceptOpaqueExecRecord(JsonObject record, String callId, boolean result) {
            JsonObject message = convertCodexMessageToFrontend(record);
            if (message != null) {
                message.getAsJsonObject("raw").addProperty("uuid", "codex-legacy:" + callId + (result ? ":result" : ""));
                this.acceptConverted(message, record);
            }
        }

        private void acceptLegacy(JsonObject rawMessage) {
            List<JsonObject> recordedCommands = CodexKnownExecReplay.readNativeCommand(rawMessage, this.processCalls);
            if (!recordedCommands.isEmpty()) {
                recordedCommands.forEach(this::acceptConverted);
                return;
            }
            List<JsonObject> activities = CodexRecordedSubagentActivity.readMessages(rawMessage);
            if (!activities.isEmpty()) {
                activities.forEach(this::acceptConverted);
                return;
            }
            List<JsonObject> web = CodexRecordedWebSearch.readMessages(rawMessage);
            if (!web.isEmpty()) {
                web.forEach(this::acceptConverted);
                return;
            }
            List<JsonObject> images = CodexRecordedImageView.readMessages(rawMessage);
            if (!images.isEmpty()) {
                images.forEach(this::acceptConverted);
                return;
            }
            List<JsonObject> generatedImages = this.generatedImages.accept(rawMessage, this.rootThreadId);
            if (!generatedImages.isEmpty()) {
                generatedImages.forEach(this::acceptConverted);
                return;
            }
            List<JsonObject> mcp = CodexRecordedMcpToolCall.readMessages(rawMessage);
            if (!mcp.isEmpty()) {
                mcp.forEach(this::acceptConverted);
                return;
            }
            JsonObject usage = extractCodexTokenCountUsage(rawMessage);
            if (usage != null) {
                attachUsageToLatestAssistant(usage);
                return;
            }

            JsonObject payload = getResponseItemPayload(rawMessage);
            String callId = getStringProperty(payload, "call_id");
            String timestamp = getStringProperty(rawMessage, "timestamp");
            String payloadType = getStringProperty(payload, "type");
            if ("custom_tool_call".equals(payloadType) || "function_call".equals(payloadType)) {
                this.recordedPatchCallId = callId != null && CodexExecHistoryReplay.isExecCall(payload)
                        && CodexExecHistoryReplay.needsRecordedPatch(payload) ? callId : null;
                this.recordedPatchItemIds.clear();
            }
            if (this.recordedPatchCallId != null) {
                List<JsonObject> recorded = CodexRecordedFileChange.readMessages(rawMessage);
                if (!recorded.isEmpty()) {
                    String itemId = getStringProperty(recorded.get(0).getAsJsonObject("raw"), "codexItemId");
                    if (this.recordedPatchItemIds.add(itemId)) {
                        // The transcript records the evaluated patch and its own outcome.
                        // Neither needs to be inferred from the opaque outer script.
                        recorded.forEach(this::acceptConverted);
                    }
                    return;
                }
                if (isToolOutputPayload(payload) && this.recordedPatchCallId.equals(callId)
                        || getCodexUserRecordKind(rawMessage) != null) {
                    this.recordedPatchCallId = null;
                    this.recordedPatchItemIds.clear();
                }
            }
            if (callId != null && CodexExecHistoryReplay.isExecCall(payload)
                    && CodexExecHistoryReplay.containsUnsupportedToolCalls(payload)) {
                List<String> patches = CodexExecHistoryReplay.extractPatches(payload);
                long previewBytes = patches.stream().mapToLong(patch -> 3L * patch.length()).sum();
                if (previewBytes <= MAX_REPLAY_BYTES) {
                    // Literal inputs still describe reviewable edits. Keep the wrapper and its
                    // shared result intact because neither proves an individual tool's outcome.
                    for (int index = 0; index < patches.size(); index++) {
                        JsonObject preview = CodexExecHistoryReplay.createPatchToolUseMessage(
                                callId, patches.get(index), index, timestamp);
                        preview.getAsJsonObject("raw").getAsJsonArray("content").get(0)
                                .getAsJsonObject().getAsJsonObject("input").addProperty("status", "unknown");
                        this.acceptConverted(preview, rawMessage);
                    }
                }
            }
            if (CodexExecHistoryReplay.isExecCall(payload) && !CodexExecHistoryReplay.containsUnsupportedToolCalls(payload)
                    && !CodexKnownExecReplay.hasUnrepresentedArrayEntries(payload)) {
                List<CodexExecHistoryReplay.Command> commands = CodexExecHistoryReplay.extractCommands(payload);
                JsonObject planInput = CodexExecHistoryReplay.extractUpdatePlanInput(payload);
                List<String> patches = CodexExecHistoryReplay.extractPatches(payload);
                long replayBytes = commands.stream().mapToLong(CodexExecHistoryReplay.Command::retainedBytes).sum()
                        + patches.stream().mapToLong(patch -> 3L * patch.length()).sum();
                if (callId != null && this.shellCalls.size() + this.planCalls.size() + this.patchCalls.size() < 256
                        && this.retainedReplayBytes() + replayBytes <= MAX_REPLAY_BYTES
                        && (!commands.isEmpty() || planInput != null || !patches.isEmpty())) {
                    if (planInput != null) {
                        this.planCalls.add(callId);
                        this.acceptConverted(CodexExecHistoryReplay.createPlanToolUseMessage(callId, planInput, timestamp), rawMessage);
                    }
                    if (!commands.isEmpty()) {
                        this.shellCalls.put(callId, commands);
                        this.acceptConverted(CodexExecHistoryReplay.createToolUseMessage(callId, commands, timestamp), rawMessage);
                    }
                    if (!patches.isEmpty()) {
                        this.patchCalls.put(callId, patches);
                        for (int index = 0; index < patches.size(); index++) {
                            this.acceptConverted(CodexExecHistoryReplay.createPatchToolUseMessage(
                                    callId, patches.get(index), index, timestamp), rawMessage);
                        }
                    }
                    return;
                }
            }
            if (isToolOutputPayload(payload) && callId != null) {
                List<CodexExecHistoryReplay.Command> commands = this.shellCalls.remove(callId);
                boolean plan = this.planCalls.remove(callId);
                List<String> patches = this.patchCalls.remove(callId);
                if (commands != null || plan || patches != null) {
                    CodexExecHistoryReplay.Output output = new CodexExecHistoryReplay.Output(payload, timestamp);
                    if (plan) {
                        this.acceptConverted(CodexExecHistoryReplay.createPlanToolResultMessage(callId, output, timestamp), rawMessage);
                    }
                    if (commands != null) {
                        this.acceptConverted(CodexExecHistoryReplay.createToolResultMessage(callId, commands, output, timestamp), rawMessage);
                    }
                    if (patches != null) {
                        for (int index = 0; index < patches.size(); index++) {
                            this.acceptConverted(CodexExecHistoryReplay.createPatchToolResultMessage(
                                    callId, index, output, timestamp), rawMessage);
                        }
                    }
                    return;
                }
            }

            JsonObject incoming = convertCodexMessageToFrontend(rawMessage);
            if (incoming == null) {
                return;
            }
            JsonObject raw = incoming.getAsJsonObject("raw");
            if (raw != null) {
                this.carryRecordedScope(incoming, rawMessage);
                String nativeId = getStringProperty(payload, "id");
                String identity = nativeId != null ? nativeId : callId != null ? callId
                        : (timestamp == null ? "record" : timestamp) + ":" + this.recordNumber;
                String suffix = isToolOutputPayload(payload) ? ":result" : "";
                raw.addProperty("uuid", "codex-legacy:" + identity + suffix);
            }

            String recordKind = getCodexUserRecordKind(rawMessage);
            if (this.pending != null && isCompactionMessage(this.pending) && isCompactionMessage(incoming)) {
                JsonObject previousRaw = this.pending.getAsJsonObject("raw");
                JsonObject nextRaw = incoming.getAsJsonObject("raw");
                String previousSource = getStringProperty(previousRaw, "compactSource");
                String nextSource = getStringProperty(nextRaw, "compactSource");
                String previousTime = getStringProperty(this.pending, "timestamp");
                String nextTime = getStringProperty(incoming, "timestamp");
                if (previousSource != null && nextSource != null && !previousSource.equals(nextSource)
                        && (previousTime == null || nextTime == null || previousTime.equals(nextTime))
                        && ("compacted".equals(previousSource) || "compacted".equals(nextSource))) {
                    if ("compacted".equals(nextSource)) {
                        this.pending = incoming;
                        this.rememberLatestAssistant(incoming);
                    }
                    return;
                }
            }
            if (recordKind != null && isUserMessage(incoming)) {
                incoming.addProperty(CODEX_RECORD_KIND, recordKind);
            }
            if (pending != null && isDuplicateAdjacentCodexUserMessage(pending, incoming)) {
                pending = preferRicherUserMessage(pending, incoming);
                pending.addProperty(CODEX_RECORD_KIND, DUAL_USER_RECORD);
                return;
            }

            emitPending();
            pending = incoming;
            rememberLatestAssistant(incoming);
        }

        /**
         * Accepts an already-converted frontend message (e.g. replayed exec tool
         * cards) while preserving ordering with the buffered pending message.
         */
        private void acceptConverted(JsonObject incoming) {
            if (incoming == null) {
                return;
            }
            JsonObject raw = incoming.getAsJsonObject("raw");
            if (raw != null && !raw.has("uuid") && raw.has("content") && !raw.getAsJsonArray("content").isEmpty()) {
                JsonObject block = raw.getAsJsonArray("content").get(0).getAsJsonObject();
                String id = getStringProperty(block, "id");
                if (id == null) {
                    id = getStringProperty(block, "tool_use_id") + ":result";
                }
                raw.addProperty("uuid", "codex-legacy:" + id);
            }
            emitPending();
            pending = incoming;
            rememberLatestAssistant(incoming);
        }

        private void acceptConverted(JsonObject incoming, JsonObject record) {
            this.carryRecordedScope(incoming, record);
            this.acceptConverted(incoming);
        }

        private void carryRecordedScope(JsonObject incoming, JsonObject record) {
            if (incoming == null || !incoming.has("raw") || !incoming.get("raw").isJsonObject()) {
                return;
            }
            JsonObject raw = incoming.getAsJsonObject("raw");
            JsonObject payload = getResponseItemPayload(record);
            if (payload == null) {
                return;
            }
            JsonObject metadata = payload.has("internal_chat_message_metadata_passthrough")
                    && payload.get("internal_chat_message_metadata_passthrough").isJsonObject()
                    ? payload.getAsJsonObject("internal_chat_message_metadata_passthrough") : null;
            String turnId = getStringProperty(payload, "turn_id");
            if (turnId == null) {
                turnId = getStringProperty(metadata, "turn_id");
            }
            String threadId = getStringProperty(payload, "thread_id");
            if (threadId == null) {
                threadId = this.rootThreadId;
            }
            // Native tools and response items must share their recorded ownership on reload.
            // Hidden reasoning without that scope would divide an otherwise continuous tool batch.
            if (getStringProperty(raw, "codexTurnId") == null && turnId != null) {
                raw.addProperty("codexTurnId", turnId);
            }
            if (getStringProperty(raw, "codexThreadId") == null && threadId != null) {
                raw.addProperty("codexThreadId", threadId);
            }
        }

        private void rememberLatestAssistant(JsonObject incoming) {
            if ("assistant".equals(getStringProperty(incoming, "type"))) {
                latestAssistant = incoming;
            }
        }

        private void attachUsageToLatestAssistant(JsonObject usage) {
            if (latestAssistant == null || usage == null) {
                return;
            }
            JsonObject raw;
            if (latestAssistant.has("raw") && latestAssistant.get("raw").isJsonObject()) {
                raw = latestAssistant.getAsJsonObject("raw");
            } else {
                raw = new JsonObject();
                latestAssistant.add("raw", raw);
            }
            raw.add("usage", usage.deepCopy());
            usageUpdated.accept(latestAssistant);
        }

        JsonObject pendingMessage() {
            if (pending == null) {
                return null;
            }
            JsonObject message = pending.deepCopy();
            message.remove(CODEX_RECORD_KIND);
            return message;
        }

        List<JsonObject> pendingMessages() {
            if (this.knownExec != null) {
                return this.knownExec.snapshot(this.processCalls);
            }
            JsonObject message = this.pendingMessage();
            return message == null ? List.of() : List.of(message);
        }

        long retainedBytes() {
            long size = this.retainedReplayBytes() + this.generatedImages.retainedBytes()
                    + (pending == null ? 0 : pending.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
            if (latestAssistant != null && latestAssistant != pending) {
                size += latestAssistant.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
            }
            return size;
        }

        private long retainedReplayBytes() {
            long bytes = this.shellCalls.values().stream().flatMap(List::stream)
                    .mapToLong(CodexExecHistoryReplay.Command::retainedBytes).sum()
                    + this.patchCalls.values().stream().flatMap(List::stream).mapToLong(patch -> 3L * patch.length()).sum();
            if (this.knownExec != null) {
                bytes += this.knownExec.retainedBytes();
            }
            for (var process : this.processCalls.entrySet()) {
                bytes += 3L * (process.getKey().length() + process.getValue().toolId().length()
                        + process.getValue().metadata().toString().length());
            }
            for (String callId : this.shellCalls.keySet()) {
                bytes += 3L * callId.length();
            }
            for (String callId : this.patchCalls.keySet()) {
                bytes += 3L * callId.length();
            }
            for (String callId : this.planCalls) {
                bytes += 3L * callId.length();
            }
            if (this.recordedPatchCallId != null) {
                bytes += 3L * this.recordedPatchCallId.length();
            }
            for (String itemId : this.recordedPatchItemIds) {
                bytes += 3L * itemId.length();
            }
            return bytes;
        }

        private void finish() {
            if (this.knownExec != null) {
                List<JsonObject> pendingKnown = this.knownExec.snapshot(this.processCalls);
                this.knownExec = null;
                pendingKnown.forEach(this::acceptConverted);
            }
            emitPending();
        }

        private void emitPending() {
            if (pending == null) {
                return;
            }
            pending.remove(CODEX_RECORD_KIND);
            consumer.accept(pending);
            pending = null;
        }
    }

    private static String getCodexUserRecordKind(JsonObject message) {
        String recordType = getStringProperty(message, "type");
        if (!message.has("payload") || !message.get("payload").isJsonObject()) {
            return null;
        }
        JsonObject payload = message.getAsJsonObject("payload");
        String payloadType = getStringProperty(payload, "type");
        if ("event_msg".equals(recordType) && "user_message".equals(payloadType)) {
            return EVENT_USER_RECORD;
        }
        if ("response_item".equals(recordType)
                && "message".equals(payloadType)
                && "user".equals(getStringProperty(payload, "role"))) {
            return RESPONSE_USER_RECORD;
        }
        return null;
    }

    private static boolean isDuplicateAdjacentCodexUserMessage(JsonObject previous, JsonObject incoming) {
        if (!isUserMessage(previous) || !isUserMessage(incoming)) {
            return false;
        }

        String previousRecordKind = getStringProperty(previous, CODEX_RECORD_KIND);
        String incomingRecordKind = getStringProperty(incoming, CODEX_RECORD_KIND);
        boolean dualRecordedPair = (EVENT_USER_RECORD.equals(previousRecordKind)
                && RESPONSE_USER_RECORD.equals(incomingRecordKind))
                || (RESPONSE_USER_RECORD.equals(previousRecordKind)
                && EVENT_USER_RECORD.equals(incomingRecordKind));
        if (!dualRecordedPair) {
            return false;
        }

        String previousContent = getStringProperty(previous, "content");
        String incomingContent = getStringProperty(incoming, "content");
        return previousContent != null
            && normalizeDuplicateUserContent(previousContent).equals(normalizeDuplicateUserContent(incomingContent));
    }

    private static JsonObject preferRicherUserMessage(JsonObject previous, JsonObject incoming) {
        return getRawContentBlockCount(incoming) > getRawContentBlockCount(previous) ? incoming : previous;
    }

    private static String normalizeDuplicateUserContent(String content) {
        if (content == null) {
            return "";
        }
        return content
            .replaceAll("(?m)^<image[^\\r\\n]*>\\R?", "")
            .replaceAll("(?m)^</image>\\R?", "")
            .trim();
    }

    private static boolean isUserMessage(JsonObject message) {
        return "user".equals(getStringProperty(message, "type"));
    }

    static String getStringProperty(JsonObject object, String propertyName) {
        if (object == null
                || !object.has(propertyName)
                || object.get(propertyName).isJsonNull()
                || !object.get(propertyName).isJsonPrimitive()) {
            return null;
        }
        return object.get(propertyName).getAsString();
    }

    private static int getRawContentBlockCount(JsonObject message) {
        if (message == null || !message.has("raw") || !message.get("raw").isJsonObject()) {
            return 0;
        }

        JsonObject raw = message.getAsJsonObject("raw");
        if (raw.has("content") && raw.get("content").isJsonArray()) {
            return raw.getAsJsonArray("content").size();
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject rawMessage = raw.getAsJsonObject("message");
            if (rawMessage.has("content") && rawMessage.get("content").isJsonArray()) {
                return rawMessage.getAsJsonArray("content").size();
            }
        }
        return 0;
    }

    /**
     * 将 Codex 历史消息恢复到后端 SessionState，保证历史加载后继续发送时，
     * 后端内存态与前端显示态使用同一份消息基线。
     */
    static void restoreCodexMessagesToSessionState(SessionState state, JsonArray messages) {
        restoreCodexFrontendMessagesToSessionState(
                state, convertCodexMessagesToFrontendBatch(messages));
    }

    private static void restoreCodexFrontendMessagesToSessionState(SessionState state,
                                                                    List<JsonObject> frontendMessages) {
        List<ClaudeSession.Message> restoredMessages = new ArrayList<>(frontendMessages.size());
        for (JsonObject frontendMsg : frontendMessages) {
            ClaudeSession.Message restoredMessage = toSessionMessage(frontendMsg);
            if (restoredMessage != null) {
                restoredMessages.add(restoredMessage);
            }
        }
        synchronized (state.getMessageStateLock()) {
            state.replaceMessages(restoredMessages);
        }
    }

    static boolean isHumanUserMessage(JsonObject message) {
        if (!isUserMessage(message)) {
            return false;
        }
        if (!message.has("raw") || !message.get("raw").isJsonObject()) {
            return !"[tool_result]".equals(getStringProperty(message, "content"));
        }

        JsonObject raw = message.getAsJsonObject("raw");
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            raw = raw.getAsJsonObject("message");
        }
        if (!raw.has("content") || !raw.get("content").isJsonArray()) {
            return !"[tool_result]".equals(getStringProperty(message, "content"));
        }
        for (JsonElement blockElement : raw.getAsJsonArray("content")) {
            if (!blockElement.isJsonObject()) {
                continue;
            }
            String blockType = getStringProperty(blockElement.getAsJsonObject(), "type");
            if ("text".equals(blockType) || "image".equals(blockType)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 将前端统一消息结构恢复为会话内存消息结构。
     */
    static ClaudeSession.Message toSessionMessage(JsonObject frontendMsg) {
        if (frontendMsg == null || !frontendMsg.has("type")) {
            return null;
        }

        String type = frontendMsg.get("type").getAsString();
        ClaudeSession.Message.Type messageType;
        switch (type) {
            case "user":
                messageType = ClaudeSession.Message.Type.USER;
                break;
            case "assistant":
                messageType = ClaudeSession.Message.Type.ASSISTANT;
                break;
            case "system":
                messageType = ClaudeSession.Message.Type.SYSTEM;
                break;
            case "error":
                messageType = ClaudeSession.Message.Type.ERROR;
                break;
            default:
                return null;
        }

        String content = frontendMsg.has("content") ? frontendMsg.get("content").getAsString() : "";
        JsonObject raw = frontendMsg.has("raw") && frontendMsg.get("raw").isJsonObject()
            ? frontendMsg.getAsJsonObject("raw")
            : null;
        ClaudeSession.Message restored = raw != null
            ? new ClaudeSession.Message(messageType, content, raw.deepCopy())
            : new ClaudeSession.Message(messageType, content);
        Long sourceTimestamp = parseFrontendTimestamp(frontendMsg);
        if (sourceTimestamp != null) {
            restored.timestamp = sourceTimestamp;
        }
        return restored;
    }

    private static Long parseFrontendTimestamp(JsonObject frontendMsg) {
        if (!frontendMsg.has("timestamp") || frontendMsg.get("timestamp").isJsonNull()) {
            return null;
        }
        JsonElement timestamp = frontendMsg.get("timestamp");
        if (!timestamp.isJsonPrimitive()) {
            return null;
        }
        try {
            if (timestamp.getAsJsonPrimitive().isNumber()) {
                return timestamp.getAsLong();
            }
            String value = timestamp.getAsString();
            if (value == null || value.isBlank()) {
                return null;
            }
            try {
                return Long.parseLong(value);
            } catch (NumberFormatException ignored) {
                return Instant.parse(value).toEpochMilli();
            }
        } catch (NumberFormatException | DateTimeParseException ignored) {
            return null;
        }
    }

    /**
     * 将单条 Codex 历史消息转换为前端消息。
     * Handles both event_msg (user messages) and response_item (assistant/tool messages).
     */
    public static JsonObject convertCodexMessageToFrontend(JsonObject msg) {
        if (!msg.has("type")) {
            return null;
        }

        String type = msg.get("type").getAsString();
        JsonObject payload = msg.has("payload") && msg.get("payload").isJsonObject()
                ? msg.getAsJsonObject("payload") : null;
        if (payload == null) {
            return null;
        }

        String timestamp = msg.has("timestamp") ? msg.get("timestamp").getAsString() : null;

        if ("compacted".equals(type)) {
            return convertCompactionToFrontend(payload, timestamp, "compacted");
        }
        if ("event_msg".equals(type) && "context_compacted".equals(getStringProperty(payload, "type"))) {
            return convertCompactionToFrontend(payload, timestamp, "context_compacted");
        }

        // Handle event_msg containing user_message
        if ("event_msg".equals(type)) {
            return convertEventMsgToFrontend(payload, timestamp);
        }

        // Handle response_item (assistant messages, function calls, etc.)
        if ("response_item".equals(type)) {
            if (!payload.has("type")) {
                return null;
            }
            String payloadType = payload.get("type").getAsString();

            if ("message".equals(payloadType)) {
                return CodexMessageConverter.convertCodexMessageToFrontend(payload, timestamp);
            }
            if ("reasoning".equals(payloadType)) {
                return CodexMessageConverter.convertReasoningToFrontend(payload, timestamp);
            }
            if ("function_call".equals(payloadType)) {
                return CodexMessageConverter.convertFunctionCallToToolUse(payload, timestamp);
            }
            if ("function_call_output".equals(payloadType)) {
                return CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, timestamp);
            }
            if ("custom_tool_call".equals(payloadType)) {
                return CodexMessageConverter.convertCustomToolCallToToolUse(payload, timestamp);
            }
            if ("custom_tool_call_output".equals(payloadType)) {
                return CodexMessageConverter.convertCustomToolCallOutputToToolResult(payload, timestamp);
            }
        }

        return null;
    }

    private static boolean isCompactionMessage(JsonObject message) {
        JsonObject raw = message.getAsJsonObject("raw");
        return raw != null && raw.has("isCompactSummary") && raw.get("isCompactSummary").getAsBoolean();
    }

    private static JsonObject convertCompactionToFrontend(JsonObject payload, String timestamp, String source) {
        JsonObject raw = new JsonObject();
        raw.addProperty("isCompactSummary", true);
        raw.addProperty("compactSource", source);
        JsonObject metadata = new JsonObject();
        metadata.addProperty("native", true);
        metadata.addProperty("status", "completed");
        String trigger = getStringProperty(payload, "trigger");
        if (trigger != null) {
            metadata.addProperty("trigger", trigger);
        }
        if (timestamp != null) {
            metadata.addProperty("timestamp", timestamp);
            metadata.addProperty("timestampSource", "item");
        }
        raw.add("summarizeMetadata", metadata);
        String summary = getStringProperty(payload, "message");
        if (summary == null) {
            summary = getStringProperty(payload, "summary");
        }
        JsonObject text = new JsonObject();
        text.addProperty("type", "text");
        text.addProperty("text", summary == null ? "" : summary);
        JsonArray blocks = new JsonArray();
        blocks.add(text);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        message.add("content", blocks);
        raw.add("message", message);
        JsonObject frontend = new JsonObject();
        frontend.addProperty("type", "assistant");
        frontend.addProperty("content", summary == null ? "" : summary);
        frontend.add("raw", raw);
        if (timestamp != null) {
            frontend.addProperty("timestamp", timestamp);
        }
        return frontend;
    }

    /**
     * Convert event_msg with user_message payload to frontend format.
     */
    private static JsonObject convertEventMsgToFrontend(JsonObject payload, String timestamp) {
        if (!payload.has("type") || !"user_message".equals(payload.get("type").getAsString())) {
            return null;
        }
        boolean hasLocalImages = hasLocalImages(payload);
        if (!payload.has("message") || payload.get("message").isJsonNull()) {
            if (!hasLocalImages) {
                return null;
            }
        }

        String rawContent = "";
        String content = "";
        if (payload.has("message") && !payload.get("message").isJsonNull()) {
            rawContent = payload.get("message").getAsString();
            content = CodexMessageConverter.stripSystemTags(rawContent);
        }
        JsonArray restoredImageBlocks = CodexMessageConverter.restoreCodexImagePlaceholderBlocks(rawContent);
        if ((content == null || content.isBlank()) && !hasLocalImages && restoredImageBlocks.size() == 0) {
            return null;
        }
        if (content == null) {
            content = "";
        }

        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "user");
        frontendMsg.addProperty("content", content);

        // Build raw structure compatible with MessageParser
        JsonObject rawObj = new JsonObject();
        JsonArray contentBlocks = buildUserMessageContentBlocks(payload, restoredImageBlocks, content);
        rawObj.add("content", contentBlocks);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    private static JsonArray buildUserMessageContentBlocks(JsonObject payload, JsonArray restoredImageBlocks, String content) {
        JsonArray contentBlocks = CodexMessageConverter.userContentBlocks(restoredImageBlocks, null);
        appendLocalImageBlocks(payload, contentBlocks);

        if (content != null && !content.isBlank()) {
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", content);
            contentBlocks.add(textBlock);
        }
        return contentBlocks;
    }

    private static boolean hasLocalImages(JsonObject payload) {
        return payload.has("local_images")
            && payload.get("local_images").isJsonArray()
            && payload.getAsJsonArray("local_images").size() > 0;
    }

    private static void appendLocalImageBlocks(JsonObject payload, JsonArray contentBlocks) {
        if (!payload.has("local_images") || !payload.get("local_images").isJsonArray()) {
            return;
        }

        JsonArray localImages = payload.getAsJsonArray("local_images");
        for (JsonElement imageElement : localImages) {
            if (!imageElement.isJsonPrimitive()) {
                continue;
            }
            String imagePath = imageElement.getAsString();
            JsonObject imageBlock = createLocalImageBlock(imagePath);
            if (imageBlock != null) {
                contentBlocks.add(imageBlock);
            }
        }
    }

    private static JsonObject createLocalImageBlock(String imagePath) {
        if (imagePath == null || imagePath.trim().isEmpty()) {
            return null;
        }

        try {
            Path path = Path.of(imagePath);
            if (!Files.isRegularFile(path)) {
                LOG.debug("[HistoryMessageInjector] Skip missing local image: " + imagePath);
                return null;
            }

            String mediaType = Files.probeContentType(path);
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = guessImageMediaType(path);
            }
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = "image/png";
            }

            String base64Data = Base64.getEncoder().encodeToString(Files.readAllBytes(path));
            JsonObject imageBlock = new JsonObject();
            imageBlock.addProperty("type", "image");
            imageBlock.addProperty("src", "data:" + mediaType + ";base64," + base64Data);
            imageBlock.addProperty("mediaType", mediaType);
            imageBlock.addProperty("alt", path.getFileName() != null ? path.getFileName().toString() : "image");
            return imageBlock;
        } catch (Exception e) {
            LOG.warn("[HistoryMessageInjector] Failed to restore local image from Codex history: " + imagePath, e);
            return null;
        }
    }

    private static String guessImageMediaType(Path path) {
        String fileName = path.getFileName() != null ? path.getFileName().toString().toLowerCase() : "";
        if (fileName.endsWith(".png")) {
            return "image/png";
        }
        if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (fileName.endsWith(".gif")) {
            return "image/gif";
        }
        if (fileName.endsWith(".webp")) {
            return "image/webp";
        }
        if (fileName.endsWith(".bmp")) {
            return "image/bmp";
        }
        if (fileName.endsWith(".svg")) {
            return "image/svg+xml";
        }
        return null;
    }

    /**
     * 分批注入前端消息，避免长历史单次传输阻塞 WebView。
     */
    private void injectCodexHistoryPage(String sessionId, CodexHistoryPage page, boolean replace) {
        String pageId = UUID.randomUUID().toString();
        Gson gson = new Gson();
        JsonObject startInfo = new JsonObject();
        startInfo.addProperty("pageId", pageId);
        startInfo.addProperty("sessionId", sessionId);
        startInfo.addProperty("mode", replace ? "replace" : "prepend");

        if (replace) {
            // Keep the session-transition barrier active until historyLoadComplete.
            context.executeJavaScriptQueued("if (window.clearMessages) { window.clearMessages(); }");
        }
        context.callJavaScript("beginCodexHistoryPage", context.escapeJs(gson.toJson(startInfo)));

        int batchCount = 0;
        int largestBatchChars = 0;
        for (List<JsonObject> batch : partitionHistoryMessages(page.messages)) {
            largestBatchChars = Math.max(largestBatchChars, sendCodexHistoryPageBatch(gson, pageId, batch));
            batchCount++;
        }

        JsonObject pageInfo = new JsonObject();
        pageInfo.addProperty("pageId", pageId);
        pageInfo.addProperty("sessionId", sessionId);
        pageInfo.addProperty("mode", replace ? "replace" : "prepend");
        pageInfo.addProperty("fromTurn", page.fromTurn);
        pageInfo.addProperty("toTurn", page.toTurn);
        pageInfo.addProperty("totalTurns", page.totalTurns);
        pageInfo.addProperty("hasMore", page.fromTurn > 0);
        pageInfo.addProperty("source", page.source);
        if (page.sessionTitle != null && !page.sessionTitle.isBlank()) {
            pageInfo.addProperty("sessionTitle", page.sessionTitle);
        }
        pageInfo.addProperty("partial", page.partial);
        if ("native".equals(page.source)) {
            pageInfo.add("cursor", page.cursor);
            pageInfo.add("requestCursor", page.requestCursor);
            pageInfo.addProperty("hasMore", page.partial);
        }
        pageInfo.addProperty("loadedMessageCount", page.messages.size());
        pageInfo.addProperty("cursorReset", page.cursorReset);
        context.callJavaScript("completeCodexHistoryPage", context.escapeJs(gson.toJson(pageInfo)));

        LOG.info("[HistoryHandler] Injected Codex history page in " + batchCount
                + " batches, mode=" + (replace ? "replace" : "prepend")
                + ", messages=" + page.messages.size()
                + ", largestBatchChars=" + largestBatchChars);
    }

    private void notifyCodexHistoryPageError(String sessionId, Integer beforeTurn, String errorMessage) {
        JsonObject error = new JsonObject();
        if (sessionId != null) {
            error.addProperty("sessionId", sessionId);
        }
        if (beforeTurn != null) {
            error.addProperty("beforeTurn", beforeTurn);
        }
        error.addProperty("message", errorMessage != null ? errorMessage : "Unknown error");
        context.callJavaScript("codexHistoryPageError", context.escapeJs(new Gson().toJson(error)));
    }

    static List<List<JsonObject>> partitionHistoryMessages(List<JsonObject> frontendMessages) {
        List<List<JsonObject>> batches = new ArrayList<>();
        if (frontendMessages == null || frontendMessages.isEmpty()) {
            return batches;
        }
        Gson gson = new Gson();
        List<JsonObject> batch = new ArrayList<>(HISTORY_BATCH_MESSAGE_LIMIT);
        int estimatedChars = 2;
        for (JsonObject message : frontendMessages) {
            int messageChars = JsUtils.escapeJs(gson.toJson(message)).length() + 1;
            if (!batch.isEmpty() && (batch.size() >= HISTORY_BATCH_MESSAGE_LIMIT
                    || estimatedChars + messageChars > HISTORY_BATCH_TARGET_CHAR_LIMIT)) {
                batches.add(List.copyOf(batch));
                batch = new ArrayList<>(HISTORY_BATCH_MESSAGE_LIMIT);
                estimatedChars = 2;
            }
            batch.add(message);
            estimatedChars += messageChars;
        }
        if (!batch.isEmpty()) {
            batches.add(List.copyOf(batch));
        }
        return batches;
    }

    private int sendCodexHistoryPageBatch(Gson gson, String pageId, List<JsonObject> batch) {
        String batchJson = gson.toJson(batch);
        String escapedBatch = JsUtils.escapeJs(batchJson);
        if (escapedBatch.length() <= HISTORY_BATCH_TARGET_CHAR_LIMIT) {
            context.callJavaScript("appendCodexHistoryPageBatch", pageId, escapedBatch);
            return escapedBatch.length();
        }

        String transferId = UUID.randomUUID().toString();
        int largestChunkChars = 0;
        List<String> chunks = splitHistoryPayload(batchJson);
        for (int i = 0; i < chunks.size(); i++) {
            String escapedChunk = JsUtils.escapeJs(chunks.get(i));
            context.callJavaScript(
                    "appendCodexHistoryPageChunk",
                    pageId,
                    escapedChunk,
                    transferId,
                    String.valueOf(i == chunks.size() - 1));
            largestChunkChars = Math.max(largestChunkChars, escapedChunk.length());
        }
        return largestChunkChars;
    }

    static List<String> splitHistoryPayload(String payload) {
        List<String> chunks = new ArrayList<>();
        if (payload == null || payload.isEmpty()) {
            return chunks;
        }

        StringBuilder current = new StringBuilder(HISTORY_BATCH_TARGET_CHAR_LIMIT);
        int escapedChars = 0;
        for (int i = 0; i < payload.length(); i++) {
            char value = payload.charAt(i);
            int charCount = escapedCharCount(current, value);
            boolean surrogatePair = Character.isHighSurrogate(value)
                    && i + 1 < payload.length()
                    && Character.isLowSurrogate(payload.charAt(i + 1));
            if (surrogatePair) {
                charCount += 1;
            }

            if (escapedChars + charCount > HISTORY_BATCH_TARGET_CHAR_LIMIT && current.length() > 0) {
                chunks.add(current.toString());
                current.setLength(0);
                escapedChars = 0;
                charCount = escapedCharCount(current, value) + (surrogatePair ? 1 : 0);
            }

            current.append(value);
            if (surrogatePair) {
                current.append(payload.charAt(++i));
            }
            escapedChars += charCount;
        }
        if (current.length() > 0) {
            chunks.add(current.toString());
        }
        return chunks;
    }

    private static int escapedCharCount(StringBuilder current, char value) {
        if (value == '\u0085' || value == '\u2028' || value == '\u2029') {
            return 6;
        }
        if (value == '\\' || value == '\'' || value == '"' || value == '`'
                || value == '\n' || value == '\r' || value == '\t'
                || value == '\b' || value == '\f' || value == '\0') {
            return 2;
        }
        if (value == '/' && current.length() > 0 && current.charAt(current.length() - 1) == '<') {
            return 2;
        }
        return 1;
    }
}
