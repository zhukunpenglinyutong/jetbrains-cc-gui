package com.github.claudecodegui.session;

import com.github.claudecodegui.util.EditOperationBuilder;
import com.github.claudecodegui.util.FileSnapshotUtil;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import org.jetbrains.annotations.NotNull;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

/** Session-owned tracker that captures file deltas produced inside sub-agent scopes. */
public final class SubagentEditScopeTracker {

    private static final Logger LOG = Logger.getInstance(SubagentEditScopeTracker.class);

    private final Project project;
    private final EditOperationRegistry registry;
    private final AtomicLong editSequence = new AtomicLong();
    private final Map<String, Scope> scopeByParentToolUseId = new HashMap<>();
    private final Map<String, Scope> scopeByAgentHandle = new HashMap<>();
    private final Map<String, PendingExternalOperation> pendingExternalOperationsByToolUseId = new HashMap<>();
    private Scope latestScope;
    private Map<String, FileSnapshotUtil.FileSnapshot> afterSnapshotForTest;

    public SubagentEditScopeTracker(Project project, EditOperationRegistry registry) {
        this.project = project;
        this.registry = registry != null ? registry : new EditOperationRegistry();
        installVfsListener();
    }

    public synchronized String startScope(String provider, String parentToolUseId, String agentHandle) {
        if (parentToolUseId != null && scopeByParentToolUseId.containsKey(parentToolUseId)) {
            return scopeByParentToolUseId.get(parentToolUseId).scopeId;
        }
        if (agentHandle != null) {
            Scope existingAgentScope = scopeByAgentHandle.get(agentHandle);
            if (existingAgentScope != null && !existingAgentScope.completed) {
                latestScope = existingAgentScope;
                return existingAgentScope.scopeId;
            }
        }
        String scopeId = provider + "_" + (parentToolUseId != null ? parentToolUseId : UUID.randomUUID());
        Scope scope = new Scope(scopeId, provider, parentToolUseId, agentHandle, FileSnapshotUtil.captureProjectSnapshot(project));
        latestScope = scope;
        if (parentToolUseId != null) {
            scopeByParentToolUseId.put(parentToolUseId, scope);
        }
        if (agentHandle != null) {
            scopeByAgentHandle.put(agentHandle, scope);
        }
        return scopeId;
    }

    public synchronized void resolveAgentHandle(String parentToolUseId, String agentHandle) {
        if (parentToolUseId == null || agentHandle == null) {
            return;
        }
        Scope scope = scopeByParentToolUseId.get(parentToolUseId);
        if (scope == null || scope.completed) {
            return;
        }
        scope.agentHandle = agentHandle;
        scopeByAgentHandle.put(agentHandle, scope);
    }

    public synchronized List<ClaudeSession.Message> completeByParentToolUseId(String parentToolUseId, String completionToken) {
        if (parentToolUseId == null) {
            return List.of();
        }
        return complete(scopeByParentToolUseId.get(parentToolUseId), completionToken);
    }

    public synchronized List<ClaudeSession.Message> completeByAgentHandle(String agentHandle, String completionToken) {
        if (agentHandle == null) {
            return List.of();
        }
        return complete(scopeByAgentHandle.get(agentHandle), completionToken);
    }

    public synchronized void cancelByParentToolUseId(String parentToolUseId) {
        if (parentToolUseId == null) {
            return;
        }
        cancel(scopeByParentToolUseId.get(parentToolUseId));
    }

    public synchronized void cancelByAgentHandle(String agentHandle) {
        if (agentHandle == null) {
            return;
        }
        cancel(scopeByAgentHandle.get(agentHandle));
    }

    public synchronized void cancelAll() {
        for (Scope scope : new ArrayList<>(activeScopes())) {
            cancel(scope);
        }
    }

    public synchronized void registerExternalOperations(JsonObject raw) {
        for (JsonObject block : contentBlocks(raw)) {
            if (!isToolUse(block) || !block.has("input") || !block.get("input").isJsonObject()) {
                continue;
            }
            JsonObject input = block.getAsJsonObject("input");
            String source = getString(input, "source");
            if ("subagent".equals(source) || "subagent_vfs".equals(source)) {
                continue;
            }
            EditOperationBuilder.Operation operation = operationFromToolInput(block, input);
            if (operation == null) {
                continue;
            }
            markPathConflicted(activeScopes(), operation.filePath());
            String toolUseId = getString(block, "id");
            PendingExternalOperation pending = new PendingExternalOperation(
                    operation,
                    source != null ? source : "main",
                    getString(input, "scope_id"),
                    getLong(input, "edit_sequence")
            );
            if (toolUseId == null) {
                registry.register(pending.operation(), pending.source(), pending.scopeId(), pending.editSequence());
            } else {
                pendingExternalOperationsByToolUseId.put(toolUseId, pending);
            }
        }
    }

    public synchronized void registerExternalResults(JsonObject raw) {
        for (JsonObject block : contentBlocks(raw)) {
            if (!"tool_result".equals(getString(block, "type"))) {
                continue;
            }
            String toolUseId = getString(block, "tool_use_id");
            if (toolUseId == null) {
                continue;
            }
            PendingExternalOperation pending = pendingExternalOperationsByToolUseId.remove(toolUseId);
            if (pending != null && !isErroredToolResult(block)) {
                registry.register(pending.operation(), pending.source(), pending.scopeId(), pending.editSequence());
            }
        }
    }

    public synchronized void recordBeforeSnapshot(String path, FileSnapshotUtil.FileSnapshot snapshot) {
        Scope scope = latestActiveScope();
        if (scope != null && path != null && snapshot != null) {
            scope.beforeByPath.put(path, snapshot);
        }
    }

    public synchronized void recordAfterSnapshotForTest(Map<String, FileSnapshotUtil.FileSnapshot> snapshots) {
        afterSnapshotForTest = snapshots;
    }

    private void installVfsListener() {
        if (project == null || project.isDisposed()) {
            return;
        }
        project.getMessageBus().connect(project).subscribe(VirtualFileManager.VFS_CHANGES, new BulkFileListener() {
            @Override
            public void before(@NotNull List<? extends VFileEvent> events) {
                recordVfsBeforeEvents(events);
            }
        });
    }

    private void recordVfsBeforeEvents(List<? extends VFileEvent> events) {
        if (events == null || events.isEmpty()) {
            return;
        }
        synchronized (this) {
            List<Scope> activeScopes = activeScopes();
            if (activeScopes.isEmpty()) {
                return;
            }
            for (VFileEvent event : events) {
                String path = normalizeProjectPath(event.getPath());
                if (path == null) {
                    continue;
                }
                Scope owner = chooseOwnerScope(activeScopes, path);
                if (owner == null) {
                    markPathAmbiguous(activeScopes, path);
                    continue;
                }
                markConflictsIfPathAlreadyOwned(activeScopes, owner, path);
                owner.beforeByPath.computeIfAbsent(path, currentPath -> readBeforeSnapshot(owner, event, currentPath));
            }
        }
    }



    synchronized void recordVfsBeforePathForTest(String path, FileSnapshotUtil.FileSnapshot snapshot) {
        List<Scope> activeScopes = activeScopes();
        Scope owner = chooseOwnerScope(activeScopes, path);
        if (owner == null || path == null || snapshot == null) {
            markPathAmbiguous(activeScopes, path);
            return;
        }
        markConflictsIfPathAlreadyOwned(activeScopes, owner, path);
        owner.beforeByPath.putIfAbsent(path, snapshot);
    }

    private Scope chooseOwnerScope(List<Scope> activeScopes, String path) {
        if (activeScopes == null || activeScopes.isEmpty()) {
            return null;
        }
        if (activeScopes.size() == 1) {
            return activeScopes.get(0);
        }
        return null;
    }

    private void markPathConflicted(List<Scope> activeScopes, String path) {
        if (path == null || activeScopes == null || activeScopes.isEmpty()) {
            return;
        }
        for (Scope scope : activeScopes) {
            scope.conflictedPaths.add(path);
        }
    }

    private void markPathAmbiguous(List<Scope> activeScopes, String path) {
        if (path == null || activeScopes == null || activeScopes.size() <= 1) {
            return;
        }
        markPathConflicted(activeScopes, path);
    }

    private void markConflictsIfPathAlreadyOwned(List<Scope> activeScopes, Scope owner, String path) {
        for (Scope scope : activeScopes) {
            if (scope != owner && scope.beforeByPath.containsKey(path)) {
                scope.conflictedPaths.add(path);
                owner.conflictedPaths.add(path);
            }
        }
    }

    private Scope latestActiveScope() {
        if (latestScope != null && !latestScope.completed) {
            return latestScope;
        }
        for (Scope scope : scopeByParentToolUseId.values()) {
            if (!scope.completed) {
                return scope;
            }
        }
        return null;
    }

    private List<Scope> activeScopes() {
        LinkedHashSet<Scope> scopes = new LinkedHashSet<>();
        scopes.addAll(scopeByParentToolUseId.values());
        scopes.addAll(scopeByAgentHandle.values());
        scopes.removeIf(scope -> scope == null || scope.completed);
        return new ArrayList<>(scopes);
    }

    private FileSnapshotUtil.FileSnapshot readBeforeSnapshot(Scope scope, VFileEvent event, String path) {
        FileSnapshotUtil.FileSnapshot baseline = scope.baselineByPath.get(path);
        if (baseline != null) {
            return baseline;
        }
        if (event instanceof VFileCreateEvent) {
            return FileSnapshotUtil.nonExistingSnapshot(path);
        }
        if (project != null) {
            LOG.warn("Skipping sub-agent edit path without reliable baseline: " + path);
            return null;
        }
        return FileSnapshotUtil.readSnapshot(Path.of(path)).orElseGet(() -> FileSnapshotUtil.nonExistingSnapshot(path));
    }

    private String normalizeProjectPath(String rawPath) {
        if (rawPath == null || rawPath.isBlank() || project == null || project.getBasePath() == null) {
            return null;
        }
        try {
            Path basePath = Path.of(project.getBasePath()).toAbsolutePath().normalize();
            Path path = Path.of(rawPath).toAbsolutePath().normalize();
            if (!path.startsWith(basePath)) {
                return null;
            }
            return path.toString();
        } catch (Exception e) {
            return null;
        }
    }

    private List<ClaudeSession.Message> complete(Scope scope, String completionToken) {
        if (scope == null || completionToken == null || scope.completed || scope.completedTokens.contains(completionToken)) {
            return List.of();
        }
        scope.completed = true;
        scope.completedTokens.add(completionToken);
        removeScope(scope);

        long sequence = editSequence.incrementAndGet();
        List<EditOperationBuilder.Operation> operations = buildOperations(scope, sequence);
        if (operations.isEmpty()) {
            return List.of();
        }
        ScopeDescriptor descriptor = new ScopeDescriptor(scope.scopeId, scope.provider, scope.parentToolUseId, scope.agentHandle, sequence);
        return SyntheticFileChangeMessageFactory.build(descriptor, operations);
    }

    private void cancel(Scope scope) {
        if (scope == null || scope.completed) {
            return;
        }
        scope.completed = true;
        removeScope(scope);
    }

    private void removeScope(Scope scope) {
        if (scope.parentToolUseId != null) {
            scopeByParentToolUseId.remove(scope.parentToolUseId);
        }
        if (scope.agentHandle != null) {
            scopeByAgentHandle.remove(scope.agentHandle);
        }
        if (latestScope == scope) {
            latestScope = null;
        }
    }

    private List<EditOperationBuilder.Operation> buildOperations(Scope scope, long sequence) {
        Set<String> paths = new LinkedHashSet<>(scope.beforeByPath.keySet());

        List<EditOperationBuilder.Operation> operations = new ArrayList<>();
        for (String path : paths) {
            if (scope.conflictedPaths.contains(path)) {
                LOG.warn("Skipping ambiguous sub-agent edit path touched by multiple active scopes: " + path);
                continue;
            }
            FileSnapshotUtil.FileSnapshot before = scope.beforeByPath.get(path);
            FileSnapshotUtil.FileSnapshot after = readAfterSnapshot(path);
            if (after == null) {
                if (before != null && before.existed() && !before.binary()) {
                    EditOperationBuilder.Operation deleteOperation = new EditOperationBuilder.Operation(
                            "edit", path, before.content(), "", false, 1, 1, false
                    );
                    if (registry.register(deleteOperation, "subagent_vfs", scope.scopeId, sequence)) {
                        operations.add(deleteOperation);
                    }
                }
                continue;
            }
            if (after.binary() || (before != null && before.binary())) {
                continue;
            }
            boolean existedBefore = before != null && before.existed();
            String beforeContent = before != null ? before.content() : "";
            String afterContent = after.content();
            for (EditOperationBuilder.Operation operation : EditOperationBuilder.build(path, existedBefore, beforeContent, afterContent)) {
                if (registry.register(operation, "subagent_vfs", scope.scopeId, sequence)) {
                    operations.add(operation);
                }
            }
        }
        return operations;
    }

    private FileSnapshotUtil.FileSnapshot readAfterSnapshot(String path) {
        if (afterSnapshotForTest != null) {
            return afterSnapshotForTest.get(path);
        }
        return FileSnapshotUtil.readSnapshot(Path.of(path)).orElse(null);
    }

    private static List<JsonObject> contentBlocks(JsonObject raw) {
        if (raw == null || !raw.has("message") || !raw.get("message").isJsonObject()) {
            return List.of();
        }
        JsonObject message = raw.getAsJsonObject("message");
        if (!message.has("content") || !message.get("content").isJsonArray()) {
            return List.of();
        }
        JsonArray content = message.getAsJsonArray("content");
        List<JsonObject> blocks = new ArrayList<>();
        for (JsonElement element : content) {
            if (element.isJsonObject()) {
                blocks.add(element.getAsJsonObject());
            }
        }
        return blocks;
    }

    private static boolean isErroredToolResult(JsonObject block) {
        if (block == null || !block.has("is_error") || block.get("is_error").isJsonNull()) {
            return false;
        }
        try {
            return block.get("is_error").getAsBoolean();
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isToolUse(JsonObject block) {
        return "tool_use".equals(getString(block, "type"));
    }

    private static EditOperationBuilder.Operation operationFromToolInput(JsonObject block, JsonObject input) {
        String toolName = getString(block, "name");
        if (toolName == null) {
            return null;
        }
        String normalizedToolName = toolName.toLowerCase(java.util.Locale.ROOT);
        if (!normalizedToolName.equals("edit") && !normalizedToolName.equals("write")
                && !normalizedToolName.equals("edit_file") && !normalizedToolName.equals("write_file")) {
            return null;
        }
        String filePath = firstNonBlank(getString(input, "file_path"), getString(input, "filePath"), getString(input, "path"));
        if (filePath == null) {
            return null;
        }
        String oldString = firstNonBlank(getString(input, "old_string"), getString(input, "oldString"));
        String newString = firstNonBlank(getString(input, "new_string"), getString(input, "newString"), getString(input, "content"));
        boolean replaceAll = getBoolean(input, "replace_all") || getBoolean(input, "replaceAll");
        int lineStart = getInt(input, "start_line", getInt(input, "lineStart", 1));
        int lineEnd = getInt(input, "end_line", getInt(input, "lineEnd", lineStart));
        boolean safeToRollback = !input.has("safe_to_rollback") || !input.get("safe_to_rollback").isJsonPrimitive()
                || input.get("safe_to_rollback").getAsBoolean();
        String operationToolName = normalizedToolName.contains("write") ? "write" : "edit";
        return new EditOperationBuilder.Operation(
                operationToolName,
                filePath,
                oldString != null ? oldString : "",
                newString != null ? newString : "",
                replaceAll,
                lineStart,
                lineEnd,
                safeToRollback
        );
    }

    private static String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        try {
            return object.get(key).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean getBoolean(JsonObject object, String key) {
        return object != null && object.has(key) && !object.get(key).isJsonNull() && object.get(key).getAsBoolean();
    }

    private static int getInt(JsonObject object, String key, int fallback) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return fallback;
        }
        try {
            return object.get(key).getAsInt();
        } catch (Exception e) {
            return fallback;
        }
    }

    private static long getLong(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return 0L;
        }
        try {
            return object.get(key).getAsLong();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    public record ScopeDescriptor(String scopeId, String provider, String parentToolUseId, String agentHandle, long editSequence) {
    }

    private static final class Scope {
        private final String scopeId;
        private final String provider;
        private final String parentToolUseId;
        private String agentHandle;
        private boolean completed;
        private final Map<String, FileSnapshotUtil.FileSnapshot> beforeByPath = new HashMap<>();
        private final Set<String> conflictedPaths = new HashSet<>();
        private final Set<String> completedTokens = new HashSet<>();
        private final Map<String, FileSnapshotUtil.FileSnapshot> baselineByPath;

        private Scope(String scopeId, String provider, String parentToolUseId, String agentHandle,
                      Map<String, FileSnapshotUtil.FileSnapshot> baselineByPath) {
            this.scopeId = scopeId;
            this.provider = provider;
            this.parentToolUseId = parentToolUseId;
            this.agentHandle = agentHandle;
            this.baselineByPath = baselineByPath != null ? baselineByPath : Map.of();
        }
    }

    private record PendingExternalOperation(
            EditOperationBuilder.Operation operation,
            String source,
            String scopeId,
            long editSequence
    ) {
    }
}
