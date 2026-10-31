package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.github.claudecodegui.handler.CodexMessageConverter;

import java.net.URI;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Replaces known wrappers only when each visible action has its own recorded outcome. */
final class CodexKnownExecReplay {
    private static final Pattern TOOL_TOKEN = Pattern.compile("(?:tools|functions)\\.[A-Za-z_][A-Za-z0-9_]*");
    private static final String JS_IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
    private static final String CATALOG_NAME = "[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*";
    private static final Set<String> CATALOG_RESERVED_BINDINGS = Set.of("tools", "ALL_TOOLS", "text");
    private static final Pattern CATALOG_MCP_PREFIX = Pattern.compile(
            "\\A\\s*const\\s+(?<selected>" + JS_IDENTIFIER + ")\\s*=\\s*ALL_TOOLS\\.find\\(\\s*"
                    + "(?<candidate>" + JS_IDENTIFIER + ")\\s*=>\\s*/\\(\\?:\\^\\|__\\)(?<tool>" + CATALOG_NAME + ")\\$/"
                    + "\\.test\\(\\s*\\k<candidate>\\.name\\s*\\)\\s*&&\\s*\\k<candidate>\\.name\\.includes\\(\\s*"
                    + "(?<quote>['\"])(?<server>" + CATALOG_NAME + ")\\k<quote>\\s*\\)\\s*\\)\\s*;\\s*"
                    + "const\\s+(?<result>" + JS_IDENTIFIER + ")\\s*=\\s*await\\s+tools\\[\\s*\\k<selected>\\.name\\s*\\]\\(\\s*");
    private static final Pattern CATALOG_MCP_ENDSWITH_PREFIX = Pattern.compile(
            "\\A\\s*const\\s+(?<selected>" + JS_IDENTIFIER + ")\\s*=\\s*ALL_TOOLS\\.find\\(\\s*"
                    + "(?<candidate>" + JS_IDENTIFIER + ")\\s*=>\\s*\\k<candidate>\\.name\\.endsWith\\(\\s*"
                    + "(?<toolQuote>['\"])(?<tool>" + CATALOG_NAME + ")\\k<toolQuote>\\s*\\)\\s*&&\\s*"
                    + "\\k<candidate>\\.name\\.includes\\(\\s*(?<quote>['\"])(?<server>" + CATALOG_NAME + ")\\k<quote>\\s*\\)\\s*\\)\\s*;\\s*"
                    + "const\\s+(?<result>" + JS_IDENTIFIER + ")\\s*=\\s*await\\s+tools\\[\\s*\\k<selected>\\.name\\s*\\]\\(\\s*");
    private static final Pattern BATCH_VARIABLE = Pattern.compile(
            "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*await\\s+Promise\\.all(?:Settled)?\\s*\\(\\s*$");
    private static final Pattern BATCH_CALLBACK = Pattern.compile(
            "^\\(\\s*\\(?\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)?\\s*=>");
    private static final Pattern BATCH_LOOP = Pattern.compile(
            "^\\(\\s*(?:let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*0\\s*;\\s*\\1\\s*<\\s*"
                    + "([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\.\\s*length\\s*;\\s*(?:\\1\\s*\\+\\+|\\+\\+\\s*\\1)\\s*\\)\\s*\\{");
    private static final Pattern BATCH_RESULT_BINDING = Pattern.compile(
            "^(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*([A-Za-z_$][A-Za-z0-9_$]*)"
                    + "\\s*\\[\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*]\\s*;?");
    private static final Pattern INDEX_LABEL = Pattern.compile(
            "text\\(\\s*(?:`([^`$\\\\]*)\\$\\{\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*}([^`$\\\\]*)`"
                    + "|(['\"])([^'\"\\\\]*)\\4\\s*\\+\\s*([A-Za-z_$][A-Za-z0-9_$]*))\\s*\\)");
    private static final int MAX_CALLS = 100;
    private static final String LOCAL_PROMISE = "Promise.resolve";
    private static final Pattern CLOCK_TIME = Pattern.compile("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} UTC");
    private static final Pattern FAILED_SCRIPT_HEADER = Pattern.compile("^Script (?:failed|terminated)\\r?\\nWall time:? [^\\r\\n]+\\r?\\nOutput:\\r?\\n");

    record Action(String kind, JsonObject input, int position, int resultIndex) { }
    record IndexLabel(Pattern pattern, boolean settledReceipt) { }
    record BatchOutput(IndexLabel indexLabel, boolean wholeSettledReceipt) { }
    // Outcome metadata must not collide with fields in a tool or local computation's value.
    record IndexedResult(JsonElement value, boolean rejected) { }
    record Process(String toolId, JsonObject metadata, String command, boolean completed) {
        Process(String toolId, JsonObject metadata) {
            this(toolId, metadata, null, false);
        }

        Process(String toolId, JsonObject metadata, String command) {
            this(toolId, metadata, command, false);
        }
    }

    private final JsonObject original;
    private final List<Action> actions;
    private final List<JsonObject> nativeRecords = new ArrayList<>();
    private final String rootThreadId;
    private final String lifecycleTurnId;
    private final String turnId;
    private final IndexLabel resultIndexLabel;
    private final boolean settledBatch;
    private final boolean wholeSettledLocalReceipt;
    private final Map<String, Integer> settledKeys;
    private final boolean staticKnown;
    private final boolean opaqueToolAccess;
    private final boolean multipleBatches;
    private boolean inventoryOnly;
    private boolean opaqueFallback;
    private boolean nativeLimitExceeded;

    private CodexKnownExecReplay(JsonObject original, List<Action> actions, String rootThreadId, String nativeTurnId) {
        this.original = original;
        this.actions = actions == null ? List.of() : actions;
        this.staticKnown = actions != null && !actions.isEmpty();
        this.rootThreadId = rootThreadId;
        this.lifecycleTurnId = nativeTurnId;
        // Model response metadata may carry a different turn ID from the app-server lifecycle.
        this.turnId = nativeTurnId != null ? nativeTurnId
                : string(object(object(original, "payload"), "internal_chat_message_metadata_passthrough"), "turn_id");
        JsonObject payload = object(original, "payload");
        String script = firstText(payload, "input", "arguments");
        this.opaqueToolAccess = actions == null && (!Set.of("tools.update_plan").equals(readToolTokens(script))
                || CodexExecHistoryReplay.findJavaScriptToken(script, "function", 0) >= 0
                || CodexExecHistoryReplay.extractUpdatePlanInput(payload) == null || CodexExecHistoryReplay.containsUnsupportedToolCalls(payload));
        this.multipleBatches = hasMultipleBatches(script);
        BatchOutput batchOutput = readBatchOutput(script);
        this.resultIndexLabel = batchOutput.indexLabel;
        this.wholeSettledLocalReceipt = batchOutput.wholeSettledReceipt;
        this.settledKeys = readSettledKeys(script);
        this.settledBatch = List.of("Promise.allSettled", "as_settled", "stream_settled").stream()
                .anyMatch(token -> CodexExecHistoryReplay.findJavaScriptToken(script, token, 0) >= 0);
    }

    static CodexKnownExecReplay begin(JsonObject record, String rootThreadId) {
        return begin(record, rootThreadId, null);
    }

    static CodexKnownExecReplay begin(JsonObject record, String rootThreadId, String nativeTurnId) {
        JsonObject payload = object(record, "payload");
        if (!CodexExecHistoryReplay.isExecCall(payload) || string(payload, "call_id") == null) {
            return null;
        }
        String script = string(payload, "input");
        if (script == null) {
            script = string(payload, "arguments");
        }
        if (script == null) {
            return null;
        }
        List<Action> actions = readActions(script, payload);
        if (actions == null || actions.isEmpty()) {
            List<Action> catalogActions = readCatalogMcpAction(script);
            if (!catalogActions.isEmpty()) {
                actions = catalogActions;
            }
        }
        return new CodexKnownExecReplay(record, actions, rootThreadId, nativeTurnId);
    }

    JsonObject original() { return this.original; }
    List<JsonObject> nativeRecords() { return this.nativeRecords; }
    String callId() { return string(object(this.original, "payload"), "call_id"); }
    String lifecycleTurnId() { return this.lifecycleTurnId; }
    boolean keepsOriginalWrapper() { return this.opaqueFallback; }
    boolean hasStaticActions() { return this.staticKnown; }
    boolean nativeLimitExceeded() { return this.nativeLimitExceeded; }

    List<JsonObject> snapshot(Map<String, Process> processes) {
        try {
            List<JsonObject> completed = this.project(null, new LinkedHashMap<>(processes));
            if (completed != null) {
                return completed;
            }
        } catch (RuntimeException ignored) {
            // Incomplete native receipts still leave the literal input available for review.
        }
        JsonObject pending = this.pendingMessage();
        return pending == null ? List.of() : List.of(pending);
    }

    private JsonObject pendingMessage() {
        if (!this.staticKnown || this.opaqueFallback || this.actions.stream().anyMatch(action -> action.kind.equals("apply_patch") && !action.input.has("patch"))) {
            // A computed patch stays reviewable until its native receipt supplies the evaluated edit.
            return HistoryMessageInjector.convertCodexMessageToFrontend(this.original);
        }
        JsonArray blocks = new JsonArray();
        for (int index = 0; index < this.actions.size(); index++) {
            Action action = this.actions.get(index);
            if (action.kind.equals("write_stdin")) {
                continue;
            }
            JsonObject block = new JsonObject();
            block.addProperty("type", "tool_use");
            boolean localPromise = LOCAL_PROMISE.equals(action.kind);
            block.addProperty("id", this.callId() + (localPromise ? ":script:" : isWeb(action.kind) ? ":web:" : isClock(action.kind) ? ":clock:" : ":command:") + index);
            block.addProperty("name", isMcp(action.kind) ? action.kind.substring(action.kind.lastIndexOf("__") + 2) : isWeb(action.kind) ? "webSearch"
                    : action.kind.equals("apply_patch") ? "apply_patch" : action.kind.equals("view_image") ? "imageView"
                    : localPromise || isClock(action.kind) ? action.kind : "bash");
            JsonObject input = localPromise || action.kind.equals("apply_patch") || action.kind.equals("view_image") || isWeb(action.kind) || isMcp(action.kind) || isClock(action.kind)
                    ? action.input.deepCopy() : commandInput(action.input, null);
            if (action.kind.equals("apply_patch")) {
                input.addProperty("status", "unknown");
            } else if (!localPromise && !action.kind.equals("view_image") && !isWeb(action.kind) && !isMcp(action.kind) && !isClock(action.kind)) {
                input.addProperty("command", command(input));
            }
            block.add("input", input);
            blocks.add(block);
        }
        if (blocks.isEmpty()) {
            return null;
        }
        JsonObject pending = message(this.original, metadata(this.original, this.rootThreadId, this.turnId), "assistant", this.callId(), blocks.get(0).getAsJsonObject());
        pending.getAsJsonObject("raw").add("content", blocks);
        return pending;
    }

    long retainedBytes() {
        return 3L * this.original.toString().length()
                + this.nativeRecords.stream().mapToLong(record -> 3L * record.toString().length()).sum();
    }

    boolean rememberNative(JsonObject record) {
        return this.rememberNative(record, Map.of());
    }

    boolean rememberNative(JsonObject record, Map<String, Process> processes) {
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        if (!"event_msg".equals(string(record, "type")) || !"item_completed".equals(string(payload, "type"))
                || !List.of("FileChange", "CommandExecution", "ImageView", "McpToolCall", "DynamicToolCall").contains(String.valueOf(string(item, "type")))
                && !CodexRecordedWebSearch.isWebItem(item)
                || string(item, "id") == null) {
            return false;
        }
        String thread = string(payload, "thread_id");
        String turn = string(payload, "turn_id");
        if (this.rootThreadId != null && thread != null && !this.rootThreadId.equals(thread)
                || this.turnId != null && turn != null && !this.turnId.equals(turn)
                && !isOwnedProcessCompletion(record, processes)) {
            return false;
        }
        for (int index = 0; index < this.nativeRecords.size(); index++) {
            JsonObject previous = object(object(this.nativeRecords.get(index), "payload"), "item");
            if (string(item, "id").equals(string(previous, "id")) && string(item, "type").equals(string(previous, "type"))) {
                this.nativeRecords.set(index, record);
                return true;
            }
        }
        if (this.nativeRecords.size() < MAX_CALLS) {
            this.nativeRecords.add(record);
            return true;
        }
        this.nativeLimitExceeded = true;
        return false;
    }

    List<JsonObject> project(JsonObject outputRecord, Map<String, Process> processes) {
        this.opaqueFallback = false;
        List<JsonObject> messages = this.projectActions(outputRecord, processes, false);
        if (messages != null || this.inventoryOnly) {
            return messages;
        }
        // A tool-only inventory cannot replace recorded local batch values or their missing evidence.
        if (this.actions.stream().noneMatch(action -> LOCAL_PROMISE.equals(action.kind))) {
            List<Action> inventory = this.readInventory(outputRecord);
            if (inventory != null && !inventory.isEmpty()) {
                CodexKnownExecReplay recorded = new CodexKnownExecReplay(this.original, inventory, this.rootThreadId, this.lifecycleTurnId);
                recorded.inventoryOnly = true;
                recorded.nativeRecords.addAll(this.nativeRecords);
                List<JsonObject> projected = recorded.project(outputRecord, processes);
                if (projected != null) {
                    this.opaqueFallback = false;
                    return projected;
                }
            }
        }
        return this.multipleBatches ? this.keepWrapperForReview() : null;
    }

    private List<JsonObject> projectActions(JsonObject outputRecord, Map<String, Process> processes, boolean failedPatchPrefix) {
        if (this.settledKeys == null && !this.inventoryOnly) {
            return this.keepWrapperForReview();
        }
        if (!this.staticKnown) {
            return this.opaqueToolAccess ? this.keepWrapperForReview() : null;
        }
        JsonObject replayScope = this.recordedScope(processes);
        if (replayScope == null) {
            return this.keepWrapperForReview();
        }
        JsonObject output = object(outputRecord, "payload");
        if (this.inventoryOnly && this.nativeRecords.stream().anyMatch(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            return List.of("FileChange", "McpToolCall", "DynamicToolCall").contains(String.valueOf(string(item, "type")))
                    && !List.of("completed", "failed", "declined", "interrupted").contains(String.valueOf(string(item, "status")));
        })) {
            return null;
        }
        List<String> texts = new ArrayList<>();
        CodexExecHistoryReplay.collectOutputTexts(output == null ? null : output.get("output"), texts);
        if (this.inventoryOnly) {
            if (texts.stream().anyMatch(text -> FAILED_SCRIPT_HEADER.matcher(text).find())) {
                // Native outcomes describe tools, not a later exception or termination in the script.
                return this.keepWrapperForReview();
            }
            texts.clear();
        }
        List<JsonObject> stopped = this.restoreStoppedSequence(outputRecord, texts, replayScope, processes);
        if (stopped != null) {
            return stopped;
        }
        if (!failedPatchPrefix && texts.stream().anyMatch(text -> FAILED_SCRIPT_HEADER.matcher(text).find())
                && (!this.nativeRecords.isEmpty() || texts.stream().anyMatch(text -> text.startsWith("Script error:"))
                || texts.stream().anyMatch(CodexExecContinuation::hasTerminatedHeader))) {
            // Native tools cannot account for an exception in the rest of the orchestration.
            return this.keepWrapperForReview();
        }
        if (this.multipleBatches) {
            // Numeric indices and direct print order are local to a batch; independent native outcomes must own every call.
            texts.clear();
        }
        Map<Integer, IndexedResult> indexed = new HashMap<>();
        List<JsonObject> direct = new ArrayList<>();
        List<JsonObject> clockReceipts = new ArrayList<>();
        Integer labeledIndex = null;
        for (String text : texts) {
            if (labeledIndex != null) {
                // Labels own the immediately printed value, including arrays, primitives and label-like text.
                JsonElement value = parseObject(text);
                if (value == null) {
                    value = new com.google.gson.JsonPrimitive(text);
                }
                IndexedResult result = successfulResult(value);
                if (this.resultIndexLabel.settledReceipt) {
                    JsonObject receipt = value.isJsonObject() ? value.getAsJsonObject() : null;
                    result = "fulfilled".equals(string(receipt, "status")) ? successfulResult(receipt.get("value"))
                            : "rejected".equals(string(receipt, "status")) ? rejectedResult(receipt.get("reason")) : null;
                }
                if (result == null || indexed.putIfAbsent(labeledIndex, result) != null) {
                    return this.keepWrapperForReview();
                }
                labeledIndex = null;
                continue;
            }
            var label = this.resultIndexLabel == null ? null : this.resultIndexLabel.pattern.matcher(text);
            if (label != null && label.matches()) {
                try {
                    labeledIndex = Integer.valueOf(label.group(1));
                } catch (NumberFormatException ignored) {
                    return this.keepWrapperForReview();
                }
                if (labeledIndex < 0 || !this.hasResultIndex(labeledIndex)) {
                    return this.keepWrapperForReview();
                }
                continue;
            }
            JsonObject value = parseObject(text);
            if (value == null) {
                continue;
            }
            if (value.has("i") || value.has("index")) {
                // Both envelopes occur in persisted wrappers; ignoring either replays native work twice.
                Integer index = this.resultSlot(value.get(value.has("i") ? "i" : "index"));
                if (index == null || value.has("i") && value.has("index") && !index.equals(this.resultSlot(value.get("index")))
                        || index < 0 || !this.hasResultIndex(index)) {
                    return this.keepWrapperForReview();
                }
                IndexedResult result = this.unwrapIndexedResult(value, index);
                if (result == null || indexed.putIfAbsent(index, result) != null) {
                    return this.keepWrapperForReview();
                }
            } else if (isProcessResult(value)) {
                direct.add(value);
            } else if (isClockReceipt(value)) {
                clockReceipts.add(value);
            }
        }
        List<JsonObject> patches = this.nativeRecords.stream()
                .filter(record -> "FileChange".equals(string(object(object(record, "payload"), "item"), "type"))).toList();
        long expectedPatches = this.actions.stream().filter(action -> action.kind.equals("apply_patch")
                && !isRejected(indexed.get(action.resultIndex))).count();
        if (expectedPatches != patches.size()) {
            return patches.size() > expectedPatches ? this.keepWrapperForReview() : null;
        }
        List<JsonObject> images = this.nativeRecords.stream()
                .filter(record -> "ImageView".equals(string(object(object(record, "payload"), "item"), "type"))).toList();
        if (this.actions.stream().filter(action -> action.kind.equals("view_image")
                && !isRejected(indexed.get(action.resultIndex))).count() != images.size()) {
            return null;
        }
        List<Action> directActions = this.actions.stream()
                .filter(action -> List.of("exec_command", "shell_command", "write_stdin").contains(action.kind))
                .filter(action -> action.resultIndex < 0 || !indexed.containsKey(action.resultIndex)).toList();
        boolean unindexedBatch = directActions.size() > 1 && directActions.stream().anyMatch(action -> action.resultIndex >= 0);
        if (!direct.isEmpty() && unindexedBatch
                && directActions.stream().anyMatch(action -> action.kind.equals("write_stdin")
                || this.findNativeCommand(action, null, processes, new HashSet<>()) == null)) {
            // An unindexed batch needs a unique recipient or independent native outcomes.
            return this.keepWrapperForReview();
        }
        for (Action action : this.actions) {
            if (!List.of("exec_command", "shell_command").contains(action.kind)) {
                continue;
            }
            String command = command(action.input);
            long calls = this.actions.stream().filter(candidate -> List.of("exec_command", "shell_command").contains(candidate.kind)
                    && command.equals(command(candidate.input))).count();
            long receipts = this.nativeRecords.stream().filter(record -> {
                JsonObject item = object(object(record, "payload"), "item");
                return "CommandExecution".equals(string(item, "type")) && command.equals(nativeCommand(item))
                        && !isOwnedProcessCompletion(record, processes);
            }).count();
            if (receipts > calls) {
                // Extra executions of the same literal can represent a loop, not a different background command.
                return this.keepWrapperForReview();
            }
        }
        if (this.actions.stream().filter(action -> isMcp(action.kind) && !isRejected(indexed.get(action.resultIndex))).count() != this.nativeRecords.stream()
                .filter(record -> "McpToolCall".equals(string(object(object(record, "payload"), "item"), "type"))).count()) {
            return null;
        }
        if (hasOuterScriptFailure(texts) && this.actions.stream().allMatch(action -> isMcp(action.kind))) {
            // Each MCP receipt owns only its own call; a later throw belongs to the wrapper, however many calls preceded it.
            return this.keepWrapperForReview();
        }
        List<JsonObject> messages = new ArrayList<>();
        Map<String, Process> nextProcesses = new LinkedHashMap<>(processes);
        int directIndex = 0;
        Set<String> usedNativeIds = new HashSet<>();
        for (int index = 0; index < this.actions.size(); index++) {
            Action action = this.actions.get(index);
            IndexedResult indexedReceipt = action.resultIndex >= 0 ? indexed.get(action.resultIndex) : null;
            JsonElement indexedResult = indexedReceipt == null ? null : indexedReceipt.value;
            if (LOCAL_PROMISE.equals(action.kind)) {
                if (indexedResult == null) {
                    return outputRecord == null ? null : this.keepWrapperForReview();
                }
                String id = this.callId() + ":script:" + index;
                JsonObject tool = new JsonObject();
                tool.addProperty("type", "tool_use");
                tool.addProperty("id", id);
                tool.addProperty("name", LOCAL_PROMISE);
                tool.add("input", action.input.deepCopy());
                messages.add(message(this.original, replayScope, "assistant", id, tool));
                JsonObject result = new JsonObject();
                if (isRejected(indexedReceipt)) {
                    result = indexedResult.getAsJsonObject();
                } else {
                    // A local value is data; command-like fields cannot establish a process failure.
                    result.addProperty("output", indexedResult.isJsonPrimitive() && indexedResult.getAsJsonPrimitive().isString()
                            ? indexedResult.getAsString() : indexedResult.toString());
                    result.addProperty("is_error", false);
                }
                messages.add(resultMessage(outputRecord, new Process(id, replayScope), result));
                continue;
            }
            if (isRejected(indexedReceipt)) {
                if (action.kind.equals("write_stdin") || action.kind.equals("apply_patch") && !action.input.has("patch")) {
                    // A failed poll does not establish the terminal state of its original process.
                    return this.keepWrapperForReview();
                }
                String id = this.callId() + (isClock(action.kind) ? ":clock:" : ":command:") + index;
                JsonObject tool = new JsonObject();
                tool.addProperty("type", "tool_use");
                tool.addProperty("id", id);
                tool.addProperty("name", isMcp(action.kind) ? action.kind.substring(action.kind.lastIndexOf("__") + 2)
                        : isWeb(action.kind) ? "webSearch" : action.kind.equals("view_image") ? "imageView"
                        : action.kind.equals("apply_patch") ? "apply_patch" : isClock(action.kind) ? action.kind : "bash");
                JsonObject input = List.of("exec_command", "shell_command").contains(action.kind)
                        ? commandInput(action.input, null) : action.input.deepCopy();
                if (action.kind.equals("apply_patch")) {
                    input.addProperty("status", "failed");
                }
                tool.add("input", input);
                messages.add(message(this.original, replayScope, "assistant", id, tool));
                messages.add(resultMessage(outputRecord, new Process(id, replayScope), indexedResult.getAsJsonObject()));
                continue;
            }
            if (action.kind.equals("apply_patch")) {
                JsonObject patch = this.findNativePatch(action, patches, usedNativeIds);
                if (patch == null) {
                    return this.keepWrapperForReview();
                }
                messages.addAll(CodexRecordedFileChange.readMessages(patch));
                continue;
            }
            if (action.kind.equals("view_image")) {
                JsonObject nativeImage = images.stream().filter(record -> {
                    JsonObject item = object(object(record, "payload"), "item");
                    return !usedNativeIds.contains(string(item, "id"))
                            && imagePath(string(item, "path")).equals(imagePath(string(action.input, "path")));
                }).findFirst().orElse(null);
                if (nativeImage == null) {
                    return this.keepWrapperForReview();
                }
                usedNativeIds.add(string(object(object(nativeImage, "payload"), "item"), "id"));
                messages.addAll(CodexRecordedImageView.readMessages(nativeImage));
                continue;
            }
            if (isClock(action.kind)) {
                // A single unindexed time receipt has one owner; multiple clocks require explicit slots.
                JsonObject receipt = indexedResult != null && indexedResult.isJsonObject() ? indexedResult.getAsJsonObject()
                        : action.resultIndex < 0 && clockReceipts.size() == 1 && this.actions.stream().filter(candidate -> isClock(candidate.kind)
                        && candidate.resultIndex < 0).count() == 1 ? clockReceipts.get(0) : null;
                if (!isClockReceipt(receipt)) {
                    return this.keepWrapperForReview();
                }
                String id = this.callId() + ":clock:" + index;
                JsonObject tool = new JsonObject();
                tool.addProperty("type", "tool_use");
                tool.addProperty("id", id);
                tool.addProperty("name", action.kind);
                tool.add("input", action.input.deepCopy());
                messages.add(message(this.original, replayScope, "assistant", id, tool));
                JsonObject clockOutput = new JsonObject();
                clockOutput.addProperty("output", receipt.toString());
                clockOutput.addProperty("is_error", false);
                messages.add(resultMessage(outputRecord, new Process(id, replayScope), clockOutput));
                continue;
            }
            if (isMcp(action.kind)) {
                JsonObject nativeRecord = this.findNativeMcp(action, usedNativeIds);
                if (nativeRecord == null) {
                    return null;
                }
                messages.addAll(CodexRecordedMcpToolCall.readMessages(nativeRecord));
                continue;
            }
            if (!List.of("exec_command", "shell_command", "write_stdin").contains(action.kind) && !isWeb(action.kind)) {
                JsonObject dynamic = this.findNativeDynamic(action, usedNativeIds);
                if (dynamic == null) {
                    return null;
                }
                messages.addAll(CodexRecordedDynamicToolCall.readMessages(dynamic));
                continue;
            }
            if (isWeb(action.kind)) {
                JsonElement webResult = indexedResult;
                if (webResult == null && this.actions.size() == 1 && output != null) {
                    String body = singleWebBody(texts);
                    if (body != null) {
                        webResult = new com.google.gson.JsonPrimitive(body);
                    }
                }
                if (webResult == null) {
                    List<JsonObject> nativeWeb = this.nativeRecords.stream()
                            .filter(record -> CodexRecordedWebSearch.isWebItem(object(object(record, "payload"), "item"))).toList();
                    if (this.actions.stream().filter(candidate -> isWeb(candidate.kind)).count() == 1 && nativeWeb.size() == 1) {
                        usedNativeIds.add(string(object(object(nativeWeb.get(0), "payload"), "item"), "id"));
                        messages.addAll(CodexRecordedWebSearch.readMessages(nativeWeb.get(0)));
                        continue;
                    }
                    return null;
                }
                String id = this.callId() + ":web:" + index;
                JsonObject metadata = replayScope;
                JsonObject tool = new JsonObject();
                tool.addProperty("type", "tool_use");
                tool.addProperty("id", id);
                tool.addProperty("name", "webSearch");
                tool.add("input", action.input.deepCopy());
                messages.add(message(this.original, metadata, "assistant", id, tool));
                JsonObject webOutput = new JsonObject();
                webOutput.addProperty("output", webResult.isJsonPrimitive() ? webResult.getAsString() : webResult.toString());
                webOutput.addProperty("is_error", webResult.isJsonObject()
                        && CodexMessageConverter.isFailedToolOutput(webResult.getAsJsonObject())
                        || this.actions.size() == 1 && output != null && CodexMessageConverter.isFailedToolOutput(output));
                messages.add(resultMessage(outputRecord == null ? this.original : outputRecord, new Process(id, metadata), webOutput));
                continue;
            }
            JsonObject result = indexedResult != null ? indexedResult.isJsonObject() ? indexedResult.getAsJsonObject() : null
                    : directIndex < direct.size() ? direct.get(directIndex++) : null;
            if (action.kind.equals("write_stdin")) {
                String sessionId = string(action.input, "session_id");
                Process process = nextProcesses.get(sessionId);
                if (process != null && process.completed && !firstText(action.input, "chars").isEmpty()) {
                    // Retained ownership proves a late receipt, not a new write to a closed process.
                    return this.keepWrapperForReview();
                }
                JsonObject completion = this.findNativeProcessCompletion(sessionId, nextProcesses, usedNativeIds);
                if (this.opaqueFallback) {
                    return null;
                }
                if (this.inventoryOnly && completion == null) {
                    // The inventory records invocation, not whether a poll produced any result.
                    return null;
                }
                if (completion != null) {
                    JsonObject item = object(object(completion, "payload"), "item");
                    if (process != null && (!nativeCommand(item).equals(process.command)
                            || !recognizesProcessCompletion(process, sessionId, completion))) {
                        return this.keepWrapperForReview();
                    }
                    // Ctrl+C can emit its native receipt before the wrapper returns. Consume it
                    // here so the later background sweep cannot recreate the interrupted command.
                    if (process == null) {
                        messages.addAll(readNativeCommand(completion, nextProcesses));
                    } else {
                        messages.add(resultMessage(completion, process, nativeCommandResult(item)));
                        nextProcesses.remove(sessionId);
                    }
                } else if (!firstText(action.input, "chars").isEmpty()
                        && (process == null || result == null || !isProcessResult(result)
                        || !isTerminal(result) && !sessionId.equals(string(result, "session_id")))) {
                    // Literal input changes a process; preserve the wrapper when its target is unknown.
                    return this.keepWrapperForReview();
                } else if (process != null && result != null && isTerminal(result) && !process.completed) {
                    messages.add(resultMessage(outputRecord, process, result));
                    // The native completion can follow this wrapper's terminal reply. Keep its
                    // ownership until then so that receipt updates this card instead of inventing one.
                    nextProcesses.put(sessionId, new Process(process.toolId, process.metadata, process.command, true));
                }
                continue;
            }
            String command = command(action.input);
            // Unindexed parallel output has no source-slot ownership, even when it carries a process id.
            String expectedProcessId = indexedResult == null && unindexedBatch ? null : string(result, "session_id");
            JsonObject nativeRecord = this.findNativeCommand(action, expectedProcessId, nextProcesses, usedNativeIds);
            if (this.opaqueFallback) {
                return null;
            }
            String toolId = nativeRecord == null ? this.callId() + ":command:" + index
                    : string(object(object(nativeRecord, "payload"), "item"), "id");
            JsonObject metadata = nativeRecord == null ? replayScope : metadata(nativeRecord,
                    string(replayScope, "codexThreadId"), string(replayScope, "codexTurnId"));
            metadata.addProperty("codexReplayedCallId", this.callId());
            Process process = new Process(toolId, metadata, command);
            JsonObject input = commandInput(action.input, object(object(nativeRecord, "payload"), "item"));
            JsonObject tool = new JsonObject();
            tool.addProperty("type", "tool_use");
            tool.addProperty("id", toolId);
            tool.addProperty("name", "bash");
            tool.add("input", input);
            messages.add(message(this.original, metadata, "assistant", toolId, tool));
            if (nativeRecord != null) {
                JsonObject item = object(object(nativeRecord, "payload"), "item");
                messages.add(resultMessage(nativeRecord, process, nativeCommandResult(item)));
            } else if (result == null || !isProcessResult(result)) {
                return null;
            } else if (isTerminal(result)) {
                messages.add(resultMessage(outputRecord, process, result));
            } else {
                String sessionId = string(result, "session_id");
                if (sessionId == null) {
                    return null;
                }
                nextProcesses.put(sessionId, process);
            }
        }
        if (directIndex != direct.size()) {
            return this.keepWrapperForReview();
        }
        if (this.nativeRecords.stream().anyMatch(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            return ("DynamicToolCall".equals(string(item, "type")) || this.inventoryOnly && !"CommandExecution".equals(string(item, "type")))
                    && !usedNativeIds.contains(string(item, "id"));
        })) {
            return this.keepWrapperForReview();
        }
        for (JsonObject message : messages) {
            message.getAsJsonObject("raw").addProperty("codexReplayedCallId", this.callId());
        }
        for (JsonObject record : this.nativeRecords) {
            JsonObject item = object(object(record, "payload"), "item");
            if ("CommandExecution".equals(string(item, "type")) && !usedNativeIds.contains(string(item, "id"))) {
                // A background command can finish while a later wrapper is awaiting its own tools.
                messages.addAll(readNativeCommand(record, nextProcesses));
            }
        }
        // Completed owners awaiting an optional native receipt must not crowd out running commands.
        var retained = nextProcesses.entrySet().iterator();
        while (nextProcesses.size() > 256 && retained.hasNext()) {
            if (retained.next().getValue().completed) {
                retained.remove();
            }
        }
        processes.clear();
        nextProcesses.forEach((id, process) -> {
            if (processes.size() < 256) {
                processes.put(id, process);
            }
        });
        return messages;
    }

    private List<Action> readInventory(JsonObject outputRecord) {
        if ((this.multipleBatches || !this.staticKnown) && firstText(object(this.original, "payload"), "input", "arguments").contains(LOCAL_PROMISE)) {
            // Tool inventories cannot establish the ownership or presence of unproven local values.
            return null;
        }
        JsonObject metadata = object(object(outputRecord, "payload"), "internal_chat_message_metadata_passthrough");
        JsonElement complete = metadata == null ? null : metadata.get("tool_calls_complete");
        JsonElement calls = metadata == null ? null : metadata.get("executed_tool_calls");
        if (complete == null || !complete.isJsonPrimitive() || !complete.getAsJsonPrimitive().isBoolean() || !complete.getAsBoolean()
                || !this.callId().equals(string(metadata, "cell_id")) || calls == null || !calls.isJsonArray() || calls.getAsJsonArray().size() > MAX_CALLS) {
            return null;
        }
        List<Action> inventory = new ArrayList<>();
        for (JsonElement entry : calls.getAsJsonArray()) {
            JsonObject call = entry.isJsonObject() ? entry.getAsJsonObject() : null;
            String name = string(call, "name");
            JsonElement arguments = call == null ? null : call.get("arguments");
            if (name == null || !name.matches("[A-Za-z_$][A-Za-z0-9_$]*") || arguments == null
                    || arguments.toString().contains("\"_codex_executed_tool_call_truncated\"")) {
                return null;
            }
            JsonObject input;
            if (name.equals("apply_patch") && arguments.isJsonPrimitive() && arguments.getAsJsonPrimitive().isString()) {
                input = new JsonObject();
                input.addProperty("patch", arguments.getAsString());
            } else if (arguments.isJsonObject()) {
                input = arguments.getAsJsonObject().deepCopy();
                if (List.of("exec_command", "shell_command", "write_stdin", "view_image").contains(name) && !validInput(name, input)) {
                    return null;
                }
            } else {
                return null;
            }
            // Inventory order is not a result index; only native outcomes may finish these cards.
            inventory.add(new Action(name, input, inventory.size(), inventory.size()));
        }
        return inventory;
    }

    private JsonObject findNativeDynamic(Action action, Set<String> usedIds) {
        List<JsonObject> matches = this.nativeRecords.stream().filter(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            String namespace = string(item, "namespace");
            String name = string(item, "tool");
            String normalized = namespace == null || namespace.isBlank() || namespace.equals("functions") ? name
                    : namespace + (namespace.endsWith("_") || name != null && name.startsWith("_") ? "" : "__") + name;
            return "DynamicToolCall".equals(string(item, "type")) && !usedIds.contains(string(item, "id"))
                    && action.kind.equals(normalized) && action.input.equals(item.get("arguments"))
                    && List.of("completed", "failed", "interrupted").contains(String.valueOf(string(item, "status")));
        }).toList();
        if (matches.size() != 1) {
            return null;
        }
        JsonObject record = matches.get(0);
        usedIds.add(string(object(object(record, "payload"), "item"), "id"));
        return record;
    }

    private JsonObject findNativePatch(Action action, List<JsonObject> patches, Set<String> usedIds) {
        Set<String> paths = new HashSet<>();
        String source = literalText(action.input, "patch");
        if (source != null) {
            var header = Pattern.compile("(?m)^\\*\\*\\* (?:Add|Update|Delete) File: (.+)").matcher(source);
            while (header.find()) {
                paths.add(patchPath(header.group(1).strip()));
            }
        }
        List<JsonObject> matches = patches.stream().filter(record -> {
            String id = string(object(object(record, "payload"), "item"), "id");
            if (usedIds.contains(id)) {
                return false;
            }
            if (paths.isEmpty()) {
                return true;
            }
            List<JsonObject> messages = CodexRecordedFileChange.readMessages(record);
            JsonArray changes = messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject()
                    .getAsJsonObject("input").getAsJsonArray("changes");
            Set<String> received = new HashSet<>();
            for (JsonElement change : changes) {
                String path = string(change.isJsonObject() ? change.getAsJsonObject() : null, "path");
                if (path != null) {
                    received.add(patchPath(path));
                }
            }
            // Independent file identities can order parallel edits; arrival order cannot.
            if (received.size() != paths.size()) {
                return false;
            }
            // Match specific suffixes first; one native path cannot account for two source files.
            for (String path : paths.stream().sorted(Comparator.comparingInt(String::length).reversed()).toList()) {
                String match = received.contains(path) ? path : received.stream()
                        .filter(candidate -> !path.startsWith("/") && !path.matches("^[A-Za-z]:/.*") && candidate.endsWith("/" + path))
                        .findFirst().orElse(null);
                if (match == null) {
                    return false;
                }
                received.remove(match);
            }
            return true;
        }).toList();
        if (matches.size() != 1) {
            return null;
        }
        JsonObject match = matches.get(0);
        usedIds.add(string(object(object(match, "payload"), "item"), "id"));
        return match;
    }

    private static String patchPath(String path) {
        return java.nio.file.Path.of(imagePath(path)).normalize().toString().replace('\\', '/');
    }

    static List<JsonObject> readNativeCommand(JsonObject record, Map<String, Process> processes) {
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        if (!"event_msg".equals(string(record, "type")) || !"item_completed".equals(string(payload, "type"))
                || !"CommandExecution".equals(string(item, "type")) || string(item, "id") == null) {
            return List.of();
        }
        String command = nativeCommand(item);
        if (command == null) {
            return List.of();
        }
        JsonObject scope = metadata(record, null, null);
        String processId = string(item, "process_id");
        List<Map.Entry<String, Process>> matching = processes.entrySet().stream().filter(entry -> {
            Process process = entry.getValue();
            return (processId == null || processId.equals(entry.getKey()))
                    && command.equals(process.command) && recognizesProcessCompletion(process, entry.getKey(), record);
        }).toList();
        Process process;
        List<JsonObject> messages = new ArrayList<>();
        if (matching.size() == 1) {
            Map.Entry<String, Process> entry = matching.get(0);
            process = entry.getValue();
            processes.remove(entry.getKey());
        } else {
            process = new Process(string(item, "id"), scope, command);
            JsonObject input = new JsonObject();
            input.addProperty("cmd", command);
            JsonObject tool = new JsonObject();
            tool.addProperty("type", "tool_use");
            tool.addProperty("id", process.toolId);
            tool.addProperty("name", "bash");
            tool.add("input", commandInput(input, item));
            messages.add(message(record, scope, "assistant", process.toolId, tool));
        }
        messages.add(resultMessage(record, process, nativeCommandResult(item)));
        return messages;
    }

    private static JsonObject nativeCommandResult(JsonObject item) {
        JsonObject result = new JsonObject();
        result.addProperty("output", nativeOutput(item));
        if (item.has("exit_code")) {
            result.add("exit_code", item.get("exit_code"));
        }
        result.addProperty("is_error", !"completed".equals(string(item, "status")));
        return result;
    }

    private static boolean recognizesProcessCompletion(Process process, String processId, JsonObject record) {
        JsonObject scope = metadata(record, null, null);
        String recordedProcessId = string(object(object(record, "payload"), "item"), "process_id");
        if (recordedProcessId == null) {
            return compatibleScope(process.metadata, scope);
        }
        String ownerThread = string(process.metadata, "codexThreadId");
        String receiptThread = string(scope, "codexThreadId");
        // A background process can finish in a later turn. Its id proves ownership,
        // but never permits a receipt from another thread to close it.
        return recordedProcessId.equals(processId)
                && (ownerThread == null || receiptThread == null || ownerThread.equals(receiptThread));
    }

    private static boolean compatibleScope(JsonObject first, JsonObject second) {
        for (String key : List.of("codexThreadId", "codexTurnId")) {
            String left = string(first, key);
            String right = string(second, key);
            if (left != null && right != null && !left.equals(right)) {
                return false;
            }
        }
        return true;
    }

    private static String nativeOutput(JsonObject item) {
        String combined = firstText(item, "aggregated_output", "formatted_output");
        if (!combined.isEmpty()) {
            return combined;
        }
        String stdout = firstText(item, "stdout");
        String stderr = firstText(item, "stderr");
        return stdout + (stdout.isEmpty() || stderr.isEmpty() || stdout.endsWith("\n") ? "" : "\n") + stderr;
    }

    private static String nativeCommand(JsonObject item) {
        JsonElement command = item.get("command");
        if (command != null && command.isJsonPrimitive()) {
            return command.getAsString();
        }
        if (command != null && command.isJsonArray() && !command.getAsJsonArray().isEmpty()) {
            List<String> arguments = new ArrayList<>();
            for (JsonElement argument : command.getAsJsonArray()) {
                if (!argument.isJsonPrimitive()) {
                    return null;
                }
                arguments.add(argument.getAsString());
            }
            if (arguments.size() >= 3 && List.of("-Command", "-command", "-c", "-lc", "-cl").contains(arguments.get(arguments.size() - 2))) {
                return arguments.get(arguments.size() - 1);
            }
            return String.join(" ", arguments.stream().map(argument -> argument.matches("[^\\s\"']+")
                    ? argument : new com.google.gson.JsonPrimitive(argument).toString()).toList());
        }
        return null;
    }

    private List<JsonObject> keepWrapperForReview() {
        this.opaqueFallback = true;
        return null;
    }

    private List<JsonObject> restoreStoppedSequence(JsonObject output, List<String> texts, JsonObject scope,
                                                    Map<String, Process> processes) {
        if (this.actions.size() < 2 || texts.stream().noneMatch(text -> text.startsWith("Script failed\n"))) {
            return null;
        }
        String script = firstText(object(this.original, "payload"), "input", "arguments");
        if (List.of("try", "catch", "for", "while").stream()
                .anyMatch(token -> CodexExecHistoryReplay.findJavaScriptToken(script, token, 0) >= 0)) {
            return null;
        }
        List<Action> edits = this.actions.stream().filter(action -> action.kind.equals("apply_patch")).toList();
        if (edits.size() != 1 || edits.get(0).resultIndex >= 0) {
            return null;
        }
        Action edit = edits.get(0);
        int end = this.actions.indexOf(edit) + 1;
        if (end == this.actions.size() || this.actions.subList(0, end).stream().anyMatch(action -> action.resultIndex >= 0)) {
            return null;
        }
        List<JsonObject> patches = this.nativeRecords.stream()
                .filter(record -> "FileChange".equals(string(object(object(record, "payload"), "item"), "type"))).toList();
        if (patches.size() == 1 && patches.get(0) == this.nativeRecords.get(this.nativeRecords.size() - 1)
                && "failed".equals(string(object(object(patches.get(0), "payload"), "item"), "status"))) {
            // A thrown edit has its own native failure; the later calls never establish outcomes.
            CodexKnownExecReplay prefix = new CodexKnownExecReplay(this.original, this.actions.subList(0, end), this.rootThreadId, this.turnId);
            prefix.nativeRecords.addAll(this.nativeRecords);
            return prefix.projectActions(output, processes, true);
        }
        String error = texts.stream().filter(text -> text.startsWith("Script error:\napply_patch verification failed:"))
                .findFirst().orElse(null);
        if (end != 1 || !this.nativeRecords.isEmpty() || string(edit.input, "patch") == null || error == null) {
            return null;
        }
        String id = this.callId() + ":patch:0";
        JsonObject tool = new JsonObject();
        tool.addProperty("type", "tool_use");
        tool.addProperty("id", id);
        tool.addProperty("name", "apply_patch");
        JsonObject input = edit.input.deepCopy();
        input.addProperty("status", "failed");
        tool.add("input", input);
        JsonObject result = new JsonObject();
        result.addProperty("output", error);
        result.addProperty("is_error", true);
        scope.addProperty("codexReplayedCallId", this.callId());
        return List.of(message(this.original, scope, "assistant", id, tool), resultMessage(output, new Process(id, scope), result));
    }

    private boolean hasResultIndex(int index) {
        return this.actions.stream().anyMatch(action -> action.resultIndex == index);
    }

    private Integer resultSlot(JsonElement value) {
        return this.settledKeys.isEmpty() ? integer(value) : value == null ? null : this.settledKeys.get(resultKey(value));
    }

    private static String resultKey(JsonElement value) {
        Integer number = integer(value);
        return number == null ? value.toString() : number.toString();
    }

    private static Map<String, Integer> readSettledKeys(String script) {
        int start = groupStart(script);
        if (start < 0 || !script.substring(0, start).matches("(?s).*\\bnew\\s+Map\\s*\\(\\s*")) {
            return Map.of();
        }
        int end = containerEnd(script, start);
        List<Integer> entries = groupEntries(script, start, end);
        if (entries == null) {
            return null;
        }
        Map<String, Integer> keys = new LinkedHashMap<>();
        for (int index = 0; index < entries.size(); index++) {
            int entryStart = entries.get(index);
            int entryEnd = script.charAt(entryStart) == '[' ? containerEnd(script, entryStart) : -1;
            if (entryEnd < entryStart || entryEnd >= end) {
                return null;
            }
            List<String> pair = CodexExecLiteralReader.split(script.substring(entryStart + 1, entryEnd), ',');
            JsonElement key = pair.size() == 2 ? CodexExecLiteralReader.read(pair.get(0), Map.of()) : null;
            if (key == null || !key.isJsonPrimitive() || !(key.getAsJsonPrimitive().isString() || integer(key) != null)
                    || keys.putIfAbsent(resultKey(key), index) != null) {
                return null;
            }
        }
        return keys;
    }

    private static BatchOutput readBatchOutput(String script) {
        int arrayStart = groupStart(script);
        if (arrayStart < 0) {
            return new BatchOutput(null, false);
        }
        var variable = BATCH_VARIABLE.matcher(script.substring(0, arrayStart));
        if (!variable.find()) {
            return new BatchOutput(null, false);
        }
        String batch = variable.group(1);
        boolean settled = script.substring(variable.start(), arrayStart).contains("Promise.allSettled");
        int afterBatch = containerEnd(script, arrayStart) + 1;
        String token = batch + ".forEach";
        int callbackStart = CodexExecHistoryReplay.findJavaScriptToken(script, token, afterBatch);
        if (callbackStart >= 0) {
            int paren = CodexExecHistoryReplay.skipTrivia(script, callbackStart + token.length(), script.length());
            var callback = BATCH_CALLBACK.matcher(script.substring(paren));
            int callbackEnd = paren < script.length() && script.charAt(paren) == '(' ? containerEnd(script, paren) : -1;
            if (callback.find() && callbackEnd > paren) {
                IndexLabel label = readPrintedIndexLabel(script, paren, callbackEnd, callback.group(1), callback.group(2), null, settled);
                if (label != null) {
                    return new BatchOutput(label, false);
                }
                if (settled && printsWholeIndexedReceipt(script, paren + callback.end(), callbackEnd, callback.group(1), callback.group(2))) {
                    return new BatchOutput(null, true);
                }
            }
        }
        int loopStart = afterBatch;
        while ((loopStart = CodexExecHistoryReplay.findJavaScriptToken(script, "for", loopStart)) >= 0) {
            int paren = CodexExecHistoryReplay.skipTrivia(script, loopStart + 3, script.length());
            var loop = BATCH_LOOP.matcher(script.substring(paren));
            if (loop.find() && batch.equals(loop.group(2))) {
                int body = paren + loop.end() - 1;
                int bodyEnd = CodexExecHistoryReplay.findMatchingObjectEnd(script, body);
                if (bodyEnd > body) {
                    IndexLabel label = readPrintedIndexLabel(script, body + 1, bodyEnd, null, loop.group(1), batch, settled);
                    if (label != null) {
                        return new BatchOutput(label, false);
                    }
                    int start = CodexExecHistoryReplay.skipTrivia(script, body + 1, bodyEnd);
                    var binding = BATCH_RESULT_BINDING.matcher(script.substring(start, bodyEnd));
                    if (settled && binding.find() && batch.equals(binding.group(2)) && loop.group(1).equals(binding.group(3))
                            && printsWholeIndexedReceipt(script, start + binding.end(), bodyEnd, binding.group(1), loop.group(1))) {
                        return new BatchOutput(null, true);
                    }
                }
            }
            loopStart += 3;
        }
        return new BatchOutput(null, false);
    }

    private static boolean printsWholeIndexedReceipt(String script, int start, int end, String resultName, String indexName) {
        int cursor = CodexExecHistoryReplay.skipTrivia(script, start, end);
        if (cursor < end && script.charAt(cursor) == '{') {
            int closing = CodexExecHistoryReplay.findMatchingObjectEnd(script, cursor);
            if (closing < 0 || CodexExecHistoryReplay.skipTrivia(script, closing + 1, end) != end) {
                return false;
            }
            end = closing;
            cursor = CodexExecHistoryReplay.skipTrivia(script, cursor + 1, end);
        }
        String indexField = "(?:(?:i|index)\\s*:\\s*" + Pattern.quote(indexName)
                + (List.of("i", "index").contains(indexName) ? "|" + Pattern.quote(indexName) : "") + ")";
        String resultField = "(?:result\\s*:\\s*" + Pattern.quote(resultName) + ("result".equals(resultName) ? "|result" : "") + ")";
        var printer = Pattern.compile("text\\s*\\(\\s*\\{\\s*(?:" + indexField + "\\s*,\\s*" + resultField
                + "|" + resultField + "\\s*,\\s*" + indexField + ")\\s*,?\\s*}\\s*\\)").matcher(script);
        printer.region(cursor, end);
        if (!printer.lookingAt()) {
            return false;
        }
        // A branch-specific printer cannot assign its envelope shape to every array slot.
        int after = CodexExecHistoryReplay.skipTrivia(script, printer.end(), end);
        if (after < end && script.charAt(after) == ';') {
            after = CodexExecHistoryReplay.skipTrivia(script, after + 1, end);
        }
        return after == end;
    }

    private static IndexLabel readPrintedIndexLabel(String script, int start, int end, String resultName, String indexName, String batchName, boolean settled) {
        var marker = INDEX_LABEL.matcher(script);
        int cursor = start;
        while ((cursor = CodexExecHistoryReplay.findJavaScriptToken(script, "text", cursor)) >= 0 && cursor < end) {
            marker.region(cursor, end);
            cursor += 4;
            if (!marker.lookingAt()) {
                continue;
            }
            boolean template = marker.group(1) != null;
            if (!indexName.equals(marker.group(template ? 2 : 6))) {
                continue;
            }
            int next = CodexExecHistoryReplay.skipTrivia(script, marker.end(), end);
            if (next < end && script.charAt(next) == ';') {
                next = CodexExecHistoryReplay.skipTrivia(script, next + 1, end);
            }
            String result = resultName;
            if (batchName != null) {
                var binding = BATCH_RESULT_BINDING.matcher(script.substring(next, end));
                if (!binding.find() || !batchName.equals(binding.group(2)) || !indexName.equals(binding.group(3))) {
                    continue;
                }
                result = binding.group(1);
                next = CodexExecHistoryReplay.skipTrivia(script, next + binding.end(), end);
            }
            // A separate label owns only the adjacent receipt read from that same batch slot.
            String tail = script.substring(next, end);
            String receipt = Pattern.quote(result);
            if (Pattern.compile("^text\\(\\s*" + receipt + "(?:\\s*\\.\\s*value|\\s*\\.\\s*status\\s*===\\s*(['\"])fulfilled\\1\\s*\\?\\s*"
                    + receipt + "\\s*\\.\\s*value\\s*:\\s*" + receipt + "\\s*\\.\\s*reason)?\\s*\\)").matcher(tail).find()) {
                boolean wholeReceipt = Pattern.compile("^text\\(\\s*" + receipt + "\\s*\\)").matcher(tail).find();
                String prefix = marker.group(template ? 1 : 5);
                String suffix = template ? marker.group(3) : "";
                return new IndexLabel(Pattern.compile(Pattern.quote(prefix) + "([0-9]+)" + Pattern.quote(suffix)), wholeReceipt && settled);
            }
        }
        return null;
    }

    private IndexedResult unwrapIndexedResult(JsonObject value, int resultIndex) {
        boolean localResult = this.actions.stream().anyMatch(action -> action.resultIndex == resultIndex && LOCAL_PROMISE.equals(action.kind));
        if (localResult && !this.settledBatch && !value.has("result")) {
            // Promise.all has no settled envelope; flattened local fields cannot prove an outcome.
            return null;
        }
        if (value.has("error") || "rejected".equals(string(value, "status"))) {
            return rejectedResult(value.has("error") ? value.get("error") : value.get("reason"));
        }
        JsonElement result = value.get("result");
        if (result == null) {
            return "fulfilled".equals(string(value, "status")) ? successfulResult(value.get("value")) : null;
        }
        // A local object lends no status unless the source explicitly printed the whole settled receipt.
        if (this.settledBatch && (!localResult || this.wholeSettledLocalReceipt) && result.isJsonObject()) {
            JsonObject receipt = result.getAsJsonObject();
            String status = string(receipt, "status");
            if ("fulfilled".equals(status)) {
                return successfulResult(receipt.get("value"));
            }
            if ("rejected".equals(status)) {
                return rejectedResult(receipt.get("reason"));
            }
        }
        // Condensed allSettled output carries the tool body directly under result.
        return successfulResult(result);
    }

    private static IndexedResult successfulResult(JsonElement value) {
        return value == null ? null : new IndexedResult(value, false);
    }

    private static IndexedResult rejectedResult(JsonElement reason) {
        JsonObject result = new JsonObject();
        result.addProperty("is_error", true);
        result.addProperty("output", reason == null || reason.isJsonNull() ? ""
                : reason.isJsonPrimitive() ? reason.getAsString() : reason.toString());
        return new IndexedResult(result, true);
    }

    private static boolean isRejected(IndexedResult result) {
        return result != null && result.rejected;
    }

    private static boolean isOwnedProcessCompletion(JsonObject record, Map<String, Process> processes) {
        JsonObject item = object(object(record, "payload"), "item");
        String processId = string(item, "process_id");
        Process owner = processId == null ? null : processes.get(processId);
        return "CommandExecution".equals(string(item, "type")) && owner != null
                && owner.command != null && owner.command.equals(nativeCommand(item))
                && recognizesProcessCompletion(owner, processId, record);
    }

    private JsonObject recordedScope(Map<String, Process> processes) {
        JsonObject scope = metadata(this.original, this.rootThreadId, this.turnId);
        for (JsonObject record : this.nativeRecords) {
            JsonObject payload = object(record, "payload");
            boolean ownedCompletion = isOwnedProcessCompletion(record, processes);
            for (String field : List.of("thread", "turn")) {
                // A proved background receipt keeps its own turn; it cannot lend that turn to this wrapper.
                // Thread conflicts still fail closed, even when a numeric process id has been reused.
                if (ownedCompletion && "turn".equals(field)) {
                    continue;
                }
                String key = "codex" + (field.equals("thread") ? "ThreadId" : "TurnId");
                String received = string(payload, field + "_id");
                String known = string(scope, key);
                if (known != null && received != null && !known.equals(received)) {
                    return null;
                }
                if (known == null && received != null) {
                    // Commands without native receipts share only the unanimously recorded wrapper scope.
                    scope.addProperty(key, received);
                }
            }
        }
        return scope;
    }

    private JsonObject findNativeMcp(Action action, Set<String> usedIds) {
        List<JsonObject> matches = this.nativeRecords.stream().filter(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            String id = string(item, "id");
            String server = string(item, "server");
            String tool = string(item, "tool");
            return "McpToolCall".equals(string(item, "type")) && id != null && !usedIds.contains(id)
                    && server != null && tool != null
                    && action.kind.equals("mcp__" + server.replace('-', '_') + "__" + tool)
                    && action.input.equals(item.get("arguments"));
        }).toList();
        if (matches.size() != 1) {
            return null;
        }
        JsonObject match = matches.get(0);
        usedIds.add(string(object(object(match, "payload"), "item"), "id"));
        return match;
    }

    private static boolean isMcp(String kind) {
        return kind.startsWith("mcp__") && kind.indexOf("__", "mcp__".length()) > "mcp__".length();
    }

    private JsonObject findNativeCommand(Action requestedAction, String expectedProcessId, Map<String, Process> processes, Set<String> usedIds) {
        String command = command(requestedAction.input);
        List<JsonObject> candidates = this.nativeRecords.stream().filter(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            String id = string(item, "id");
            // A process id keeps its receipt only when the command and thread prove the same owner.
            return "CommandExecution".equals(string(item, "type")) && id != null && !usedIds.contains(id)
                    && !isOwnedProcessCompletion(record, processes) && command.equals(nativeCommand(item))
                    && List.of("completed", "failed", "declined", "interrupted").contains(String.valueOf(string(item, "status")));
        }).toList();
        boolean identified = false;
        if (expectedProcessId != null) {
            List<JsonObject> matches = candidates.stream()
                    .filter(record -> expectedProcessId.equals(string(object(object(record, "payload"), "item"), "process_id"))).toList();
            if (!matches.isEmpty()) {
                candidates = matches;
                identified = true;
            } else {
                candidates = candidates.stream().filter(record -> string(object(object(record, "payload"), "item"), "process_id") == null).toList();
            }
        }
        if (candidates.isEmpty()) {
            return null;
        }
        String directory = absoluteDirectory(firstText(requestedAction.input, "workdir", "cwd"));
        if (!identified && directory != null) {
            List<JsonObject> matches = candidates.stream().filter(record -> directory.equals(
                    absoluteDirectory(string(object(object(record, "payload"), "item"), "cwd")))).toList();
            long directoryOwners = this.actions.stream()
                    .filter(candidate -> List.of("exec_command", "shell_command").contains(candidate.kind)
                            && command.equals(command(candidate.input)))
                    .filter(candidate -> {
                        String candidateDirectory = absoluteDirectory(firstText(candidate.input, "workdir", "cwd"));
                        return candidateDirectory == null || directory.equals(candidateDirectory);
                    }).count();
            // A completed exec result often omits its session id; a unique absolute cwd still proves ownership.
            if (matches.size() == 1 && directoryOwners == 1) {
                candidates = matches;
                identified = true;
            }
        }
        // Parallel commands can finish out of order, so identical source text cannot assign their receipts.
        long owners = this.actions.stream().filter(action -> List.of("exec_command", "shell_command").contains(action.kind)
                && command.equals(command(action.input))).count();
        boolean parallel = this.actions.stream().anyMatch(action -> action.resultIndex >= 0
                && List.of("exec_command", "shell_command").contains(action.kind) && command.equals(command(action.input)));
        if (identified && candidates.size() != 1 || !identified && owners > 1 && (parallel || expectedProcessId != null)) {
            this.opaqueFallback = true;
            return null;
        }
        JsonObject receipt = candidates.get(0);
        JsonObject item = object(object(receipt, "payload"), "item");
        JsonObject scope = metadata(receipt, null, null);
        if (string(item, "process_id") == null && processes.values().stream().anyMatch(process -> command.equals(process.command)
                && compatibleScope(process.metadata, scope))) {
            this.opaqueFallback = true;
            return null;
        }
        usedIds.add(string(item, "id"));
        return receipt;
    }

    private static String absoluteDirectory(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String path = value;
        if (path.startsWith("file:")) {
            try {
                URI uri = URI.create(path);
                if (uri.getAuthority() != null && !uri.getAuthority().isEmpty() && !"localhost".equalsIgnoreCase(uri.getAuthority())) {
                    return null;
                }
                path = uri.getPath();
            } catch (IllegalArgumentException error) {
                return null;
            }
        }
        if (path == null) {
            return null;
        }
        if (value.startsWith("file:") && path.matches("^/[A-Za-z]:/.*")) {
            path = path.substring(1);
        }
        // A backslash in an absolute POSIX path belongs to the filename, not the directory structure.
        if (!path.startsWith("/")) {
            path = path.replace('\\', '/');
        }
        if (!path.startsWith("/") && !path.matches("^[A-Za-z]:/.*")) {
            return null;
        }
        while (path.length() > 1 && path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        return path;
    }

    private JsonObject findNativeProcessCompletion(String processId, Map<String, Process> processes, Set<String> usedIds) {
        List<JsonObject> candidates = this.nativeRecords.stream().filter(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            String id = string(item, "id");
            return "CommandExecution".equals(string(item, "type")) && id != null && !usedIds.contains(id)
                    && nativeCommand(item) != null
                    && List.of("completed", "failed", "declined", "interrupted").contains(String.valueOf(string(item, "status")));
        }).toList();
        List<JsonObject> matches = candidates.stream()
                .filter(record -> processId.equals(string(object(object(record, "payload"), "item"), "process_id"))).toList();
        if (matches.isEmpty()) {
            Process process = processes.get(processId);
            if (process == null || process.command == null) {
                return null;
            }
            matches = candidates.stream().filter(record -> {
                JsonObject item = object(object(record, "payload"), "item");
                return string(item, "process_id") == null && process.command.equals(nativeCommand(item))
                        && compatibleScope(process.metadata, metadata(record, null, null));
            }).toList();
            if (matches.size() == 1) {
                // Older receipts omit process ids; shared command text cannot prove which process ended.
                JsonObject scope = metadata(matches.get(0), null, null);
                long owners = processes.values().stream().filter(candidate -> process.command.equals(candidate.command)
                        && compatibleScope(candidate.metadata, scope)).count();
                boolean siblingCommand = this.actions.stream().anyMatch(action -> List.of("exec_command", "shell_command").contains(action.kind)
                        && process.command.equals(command(action.input)));
                if (owners != 1 || siblingCommand) {
                    this.opaqueFallback = true;
                    return null;
                }
            }
        }
        if (matches.size() > 1) {
            this.opaqueFallback = true;
            return null;
        }
        if (matches.size() != 1) {
            return null;
        }
        JsonObject completion = matches.get(0);
        usedIds.add(string(object(object(completion, "payload"), "item"), "id"));
        return completion;
    }

    private static List<Action> readCatalogMcpAction(String script) {
        // Accept only the complete, side-effect-free catalog wrapper. Native scope, arguments and uniqueness still own the result.
        // Restricted literal names also keep the canonical server/tool separator unambiguous.
        var prefix = CATALOG_MCP_PREFIX.matcher(script);
        if (!prefix.find()) {
            prefix = CATALOG_MCP_ENDSWITH_PREFIX.matcher(script);
            if (!prefix.find()) {
                return List.of();
            }
        }
        String selected = prefix.group("selected");
        String result = prefix.group("result");
        if (selected.equals(result) || CATALOG_RESERVED_BINDINGS.contains(selected) || CATALOG_RESERVED_BINDINGS.contains(result)) {
            return List.of();
        }
        int start = prefix.end();
        if (start >= script.length() || script.charAt(start) != '{') {
            return List.of();
        }
        int end = CodexExecHistoryReplay.findMatchingObjectEnd(script, start);
        if (end < start) {
            return List.of();
        }
        if (!isCatalogMcpOutput(script.substring(end + 1), result)) {
            return List.of();
        }
        String literal = CodexExecHistoryReplay.normalizeJavaScriptLiteralToJson(script.substring(start, end + 1));
        JsonObject input = literal == null ? null : parseObject(literal);
        return input == null ? List.of()
                : List.of(new Action("mcp__" + prefix.group("server") + "__" + prefix.group("tool"), input, prefix.start(), -1));
    }

    private static boolean isCatalogMcpOutput(String suffix, String result) {
        String quotedResult = Pattern.quote(result);
        if (suffix.matches("\\s*\\)\\s*;\\s*text\\(\\s*" + quotedResult + "\\s*\\)\\s*;?\\s*")) {
            return true;
        }
        var contentLoop = Pattern.compile("\\s*\\)\\s*;\\s*for\\s*\\(\\s*const\\s+(?<block>" + JS_IDENTIFIER + ")\\s+of\\s+"
                + quotedResult + "\\.content\\s*\\?\\?\\s*\\[\\s*\\]\\s*\\)\\s*\\{\\s*if\\s*\\(\\s*\\k<block>\\.type\\s*===\\s*"
                + "(?<quote>['\"])text\\k<quote>\\s*\\)\\s*text\\(\\s*\\k<block>\\.text\\s*\\)\\s*;?\\s*\\}\\s*;?\\s*")
                .matcher(suffix);
        return contentLoop.matches() && !"text".equals(contentLoop.group("block")) && !result.equals(contentLoop.group("block"));
    }

    private static boolean hasOuterScriptFailure(List<String> texts) {
        if (texts.isEmpty()) {
            return false;
        }
        // Only the engine's first header owns the wrapper outcome; MCP content can independently report an error.
        String header = texts.get(0).stripLeading().lines().findFirst().orElse("");
        return "Script failed".equals(header) || header.startsWith("Script error:");
    }

    private static List<Action> readActions(String script, JsonObject payload) {
        if (CodexExecHistoryReplay.containsUnparsedExpression(script) || CodexExecHistoryReplay.findJavaScriptToken(script, "function", 0) >= 0) {
            // Hoisted functions can run in a different order from their source declarations.
            return null;
        }
        script = CodexExecLiteralReader.normalizeToolAccess(script);
        payload = payload.deepCopy();
        payload.addProperty("input", script);
        Set<String> tokens = readToolTokens(script);
        if (tokens == null) {
            return null;
        }
        List<Action> actions = new ArrayList<>();
        List<String> patches = CodexExecHistoryReplay.extractPatches(payload);
        int patchCount = 0;
        boolean multipleBatches = hasMultipleBatches(script);
        if (multipleBatches && CodexExecHistoryReplay.findJavaScriptToken(script, LOCAL_PROMISE, 0) >= 0) {
            return null;
        }
        int groupStart = groupStart(script);
        int groupEnd = groupStart < 0 ? -1 : containerEnd(script, groupStart);
        List<Integer> groupEntries = groupStart < 0 ? List.of() : groupEntries(script, groupStart, groupEnd);
        Map<String, Integer> settledKeys = readSettledKeys(script);
        if (groupEntries == null || settledKeys == null) {
            return null;
        }
        for (String token : tokens) {
            int position = 0;
            while ((position = CodexExecHistoryReplay.findJavaScriptToken(script, token, position)) >= 0) {
                String kind = token.substring(token.indexOf('.') + 1);
                if (!List.of("apply_patch", "exec_command", "shell_command", "write_stdin", "view_image", "web__run", "web_run").contains(kind) && !isMcp(kind) && !isClock(kind)) {
                    return null;
                }
                int paren = CodexExecHistoryReplay.skipTrivia(script, position + token.length(), script.length());
                if (paren >= script.length() || script.charAt(paren) != '(') {
                    return null;
                }
                if (!kind.equals("apply_patch")) {
                    CodexMappedCommandBatch.Batch batch = CodexMappedCommandBatch.readInputs(script, token, position);
                    if (batch != null) {
                        if (!groupEntries.isEmpty() || actions.size() + batch.inputs().size() > MAX_CALLS) {
                            return null;
                        }
                        for (int index = 0; index < batch.inputs().size(); index++) {
                            JsonObject input = batch.inputs().get(index);
                            if (!validInput(kind, input)) {
                                return null;
                            }
                            actions.add(new Action(kind, input, position, batch.parallel() && !multipleBatches ? index : -1));
                        }
                        position += token.length();
                        continue;
                    }
                }
                if (!CodexExecLiteralReader.reachesCallInSourceOrder(script, position)) {
                    return null;
                }
                JsonObject input;
                if (kind.equals("apply_patch")) {
                    input = new JsonObject();
                    patchCount++;
                    int end = CodexExecHistoryReplay.findMatchingParenthesisEnd(script, paren);
                    if (end < paren) {
                        return null;
                    }
                    JsonElement patch = readLiteralArgument(script, paren + 1, end);
                    if (patch != null && patch.isJsonPrimitive() && patch.getAsJsonPrimitive().isString()) {
                        input.addProperty("patch", patch.getAsString());
                    }
                } else {
                    int start = CodexExecHistoryReplay.skipTrivia(script, paren + 1, script.length());
                    int end = CodexExecHistoryReplay.findMatchingParenthesisEnd(script, paren);
                    if (end < start) {
                        return null;
                    }
                    JsonElement literal = readLiteralArgument(script, start, end);
                    input = literal != null && literal.isJsonObject() ? literal.getAsJsonObject() : null;
                    if (!validInput(kind, input)) {
                        return null;
                    }
                }
                int resultIndex = -1;
                for (int entry = 0; entry < groupEntries.size(); entry++) {
                    int start = groupEntries.get(entry);
                    int end = entry + 1 < groupEntries.size() ? groupEntries.get(entry + 1) : groupEnd;
                    if (position >= start && position < end) {
                        resultIndex = entry;
                        break;
                    }
                }
                actions.add(new Action(kind, input, position, resultIndex));
                if (actions.size() > MAX_CALLS) {
                    return null;
                }
                position += token.length();
            }
        }
        actions.sort(Comparator.comparingInt(Action::position));
        List<Action> indexed = new ArrayList<>();
        int patchIndex = 0;
        Set<Integer> representedEntries = new HashSet<>();
        for (Action action : actions) {
            if (action.kind.equals("apply_patch") && patchCount == patches.size()) {
                action.input.addProperty("patch", patches.get(patchIndex++));
            }
            if (action.resultIndex >= 0 && !representedEntries.add(action.resultIndex)) {
                return null;
            }
            indexed.add(action);
        }
        for (int index = 0; index < groupEntries.size(); index++) {
            if (!representedEntries.contains(index)) {
                int start = groupEntries.get(index);
                int end = index + 1 < groupEntries.size() ? groupEntries.get(index + 1) : groupEnd;
                JsonObject input;
                if (!settledKeys.isEmpty() && script.charAt(start) == '[') {
                    int entryEnd = containerEnd(script, start);
                    List<String> pair = CodexExecLiteralReader.split(script.substring(start + 1, entryEnd), ',');
                    input = pair.size() == 2 ? readLocalPromiseInput(pair.get(1), 0, pair.get(1).length()) : null;
                } else {
                    input = readLocalPromiseInput(script, start, end);
                }
                if (input == null || indexed.size() >= MAX_CALLS) {
                    return null;
                }
                indexed.add(new Action(LOCAL_PROMISE, input, start, index));
            }
        }
        // Local computations keep their array slots without being mistaken for shell commands.
        indexed.sort(Comparator.comparingInt(Action::position));
        return indexed;
    }

    private static JsonElement readLiteralArgument(String script, int start, int end) {
        String expression = script.substring(start, end);
        JsonElement literal = CodexExecLiteralReader.read(expression, Map.of());
        // Most calls contain complete literals; unrelated declarations need no repeated binding analysis.
        return literal != null ? literal : CodexExecLiteralReader.read(expression, CodexExecLiteralReader.readBindings(script, start, end));
    }

    private static Set<String> readToolTokens(String script) {
        Set<String> tokens = new HashSet<>();
        for (String namespace : List.of("tools", "functions")) {
            int cursor = 0;
            while ((cursor = CodexExecHistoryReplay.findJavaScriptToken(script, namespace, cursor)) >= 0) {
                int next = CodexExecHistoryReplay.skipTrivia(script, cursor + namespace.length(), script.length());
                String prefix = script.substring(0, cursor).stripTrailing();
                if (next < script.length() && script.charAt(next) == ':' && (prefix.endsWith("{") || prefix.endsWith(","))) {
                    // A literal property key does not refer to the runtime namespace.
                    cursor += namespace.length();
                    continue;
                }
                var token = TOOL_TOKEN.matcher(script);
                token.region(cursor, script.length());
                if (!token.lookingAt()) {
                    // A computed access or namespace alias can hide calls beside a known command.
                    return null;
                }
                tokens.add(token.group());
                cursor = token.end();
            }
        }
        return tokens;
    }

    private static boolean validInput(String kind, JsonObject input) {
        return input != null && (kind.equals("write_stdin") ? (!input.has("chars") || literalText(input, "chars") != null) && string(input, "session_id") != null
                : kind.equals("view_image") ? string(input, "path") != null : isClock(kind) ? input.size() == 0
                : isWeb(kind) || isMcp(kind) || command(input) != null);
    }

    private static JsonObject readLocalPromiseInput(String script, int start, int end) {
        if (!script.startsWith(LOCAL_PROMISE, start)) {
            return null;
        }
        int paren = CodexExecHistoryReplay.skipTrivia(script, start + LOCAL_PROMISE.length(), end);
        if (paren >= end || script.charAt(paren) != '(') {
            return null;
        }
        int closing = containerEnd(script, paren);
        if (closing < paren || closing >= end) {
            return null;
        }
        int after = CodexExecHistoryReplay.skipTrivia(script, closing + 1, end);
        if (after < end && script.charAt(after) == ',') {
            after = CodexExecHistoryReplay.skipTrivia(script, after + 1, end);
        }
        if (after != end) {
            return null;
        }
        JsonObject input = new JsonObject();
        input.addProperty("code", script.substring(start, closing + 1));
        return input;
    }

    static boolean hasUnrepresentedArrayEntries(JsonObject payload) {
        String script = string(payload, "input");
        if (script == null) {
            script = string(payload, "arguments");
        }
        if (script == null) {
            return false;
        }
        int start = groupStart(script);
        if (start < 0) {
            return false;
        }
        int end = containerEnd(script, start);
        List<Integer> entries = groupEntries(script, start, end);
        if (entries == null) {
            return true;
        }
        Set<String> tokens = new HashSet<>();
        var matcher = TOOL_TOKEN.matcher(script);
        while (matcher.find()) {
            tokens.add(matcher.group());
        }
        for (int index = 0; index < entries.size(); index++) {
            int entryStart = entries.get(index);
            int entryEnd = index + 1 < entries.size() ? entries.get(index + 1) : end;
            boolean represented = false;
            for (String token : tokens) {
                int position = CodexExecHistoryReplay.findJavaScriptToken(script, token, entryStart);
                if (position >= entryStart && position < entryEnd) {
                    represented = true;
                    break;
                }
            }
            if (!represented) {
                return true;
            }
        }
        return false;
    }

    private static int groupStart(String script) {
        int found = -1;
        for (String token : List.of("Promise.allSettled", "Promise.all", "as_settled", "stream_settled")) {
            int position = CodexExecHistoryReplay.findJavaScriptToken(script, token, 0);
            if (position < 0) {
                continue;
            }
            if (found >= 0 || CodexExecHistoryReplay.findJavaScriptToken(script, token, position + token.length()) >= 0) {
                return -1;
            }
            int paren = CodexExecHistoryReplay.skipTrivia(script, position + token.length(), script.length());
            if (paren >= script.length() || script.charAt(paren) != '(') {
                continue;
            }
            int start = CodexExecHistoryReplay.skipTrivia(script, paren + 1, script.length());
            if (List.of("as_settled", "stream_settled").contains(token)) {
                var map = Pattern.compile("new\\s+Map\\s*\\(\\s*(\\[)").matcher(script);
                map.region(start, script.length());
                if (map.lookingAt()) {
                    start = map.start(1);
                }
            }
            if (start < script.length() && script.charAt(start) == '[') {
                found = start;
            }
        }
        return found;
    }

    private static boolean hasMultipleBatches(String script) {
        int count = 0;
        for (String token : List.of("Promise.allSettled", "Promise.all", "as_settled", "stream_settled")) {
            int cursor = 0;
            while ((cursor = CodexExecHistoryReplay.findJavaScriptToken(script, token, cursor)) >= 0) {
                if (++count > 1) {
                    return true;
                }
                cursor += token.length();
            }
        }
        return false;
    }

    private static int containerEnd(String script, int start) {
        char opening = script.charAt(start);
        char closing = opening == '[' ? ']' : ')';
        int depth = 0;
        for (int index = start; index < script.length(); index++) {
            char value = script.charAt(index);
            if (value == '\'' || value == '"' || value == '`') {
                index = CodexExecHistoryReplay.skipJavaScriptString(script, index) - 1;
            } else if (value == '/' && index + 1 < script.length()
                    && (script.charAt(index + 1) == '/' || script.charAt(index + 1) == '*')) {
                index = CodexExecHistoryReplay.skipTrivia(script, index, script.length()) - 1;
            } else if (value == opening) {
                depth++;
            } else if (value == closing && --depth == 0) {
                return index;
            }
        }
        return -1;
    }

    private static List<Integer> groupEntries(String script, int start, int end) {
        if (end < start) {
            return null;
        }
        List<Integer> entries = new ArrayList<>();
        int cursor = CodexExecHistoryReplay.skipTrivia(script, start + 1, end);
        if (cursor < end) {
            entries.add(cursor);
        }
        int depth = 0;
        for (int index = cursor; index < end; index++) {
            char value = script.charAt(index);
            if (value == '\'' || value == '"' || value == '`') {
                index = CodexExecHistoryReplay.skipJavaScriptString(script, index) - 1;
            } else if (value == '/' && index + 1 < end
                    && (script.charAt(index + 1) == '/' || script.charAt(index + 1) == '*')) {
                index = CodexExecHistoryReplay.skipTrivia(script, index, end) - 1;
            } else if (value == '(' || value == '{' || value == '[') {
                depth++;
            } else if (value == ')' || value == '}' || value == ']') {
                depth--;
            } else if (value == ',' && depth == 0) {
                int next = CodexExecHistoryReplay.skipTrivia(script, index + 1, end);
                if (next < end) {
                    entries.add(next);
                }
            }
        }
        return entries;
    }

    private static boolean isWeb(String kind) {
        return "web__run".equals(kind) || "web_run".equals(kind);
    }

    private static boolean isClock(String kind) {
        return "clock__curr_time".equals(kind);
    }

    private static boolean isClockReceipt(JsonObject value) {
        String time = string(value, "current_time");
        return value != null && value.size() == 1 && time != null && CLOCK_TIME.matcher(time).matches();
    }

    private static String imagePath(String path) {
        if (path == null) {
            return "";
        }
        String normalized = path.replace('\\', '/');
        if (normalized.startsWith("file:")) {
            try {
                URI uri = URI.create(normalized);
                if (uri.getPath() != null) {
                    // Native receipts encode spaces while the tool input carries a filesystem path.
                    normalized = (uri.getAuthority() == null ? "" : "//" + uri.getAuthority()) + uri.getPath();
                }
            } catch (IllegalArgumentException ignored) {
                // Older receipts can contain unescaped file paths; keep their literal spelling.
                if (normalized.startsWith("file:///")) {
                    normalized = normalized.substring("file://".length());
                }
            }
            if (normalized.length() > 2 && normalized.charAt(2) == ':') {
                normalized = normalized.substring(1);
            }
        }
        return normalized;
    }

    private static String singleWebBody(List<String> texts) {
        List<String> bodies = new ArrayList<>();
        for (String text : texts) {
            String trimmed = text.stripLeading();
            if (trimmed.startsWith("Script running")) {
                return null;
            }
            if (trimmed.startsWith("Script completed") || trimmed.startsWith("Script failed") || trimmed.startsWith("Script error")) {
                int output = trimmed.indexOf("Output:");
                if (output >= 0) {
                    String body = trimmed.substring(output + "Output:".length()).stripLeading();
                    if (!body.isEmpty()) {
                        bodies.add(body);
                    }
                }
            } else {
                bodies.add(text);
            }
        }
        return bodies.isEmpty() ? null : String.join("\n", bodies);
    }

    private static JsonObject resultMessage(JsonObject record, Process process, JsonObject result) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", process.toolId);
        block.addProperty("content", firstText(result, "output", "aggregated_output", "stdout"));
        block.addProperty("is_error", result.has("is_error") && result.get("is_error").getAsBoolean()
                || result.has("exit_code") && !result.get("exit_code").isJsonNull() && result.get("exit_code").getAsInt() != 0);
        return message(record, process.metadata, "user", process.toolId + ":result", block);
    }

    private static JsonObject metadata(JsonObject record, String threadId, String turnId) {
        JsonObject payload = object(record, "payload");
        JsonObject metadata = new JsonObject();
        metadata.addProperty("codexThreadId", string(payload, "thread_id") == null ? threadId : string(payload, "thread_id"));
        metadata.addProperty("codexTurnId", string(payload, "turn_id") == null ? turnId : string(payload, "turn_id"));
        return metadata;
    }

    private static JsonObject message(JsonObject record, JsonObject metadata, String role, String id, JsonObject block) {
        JsonObject raw = metadata.deepCopy();
        String threadId = string(metadata, "codexThreadId");
        String turnId = string(metadata, "codexTurnId");
        raw.addProperty("uuid", threadId != null && turnId != null
                ? "codex:" + threadId + ":" + turnId + ":" + id : "codex-known-exec:" + id);
        raw.addProperty("codexItemId", id);
        raw.addProperty("codexAuthoritative", true);
        JsonArray content = new JsonArray();
        content.add(block);
        raw.add("content", content);
        JsonObject message = new JsonObject();
        message.addProperty("type", role);
        message.addProperty("content", "assistant".equals(role) ? "" : "[tool_result]");
        message.add("raw", raw);
        String timestamp = string(record, "timestamp");
        if (timestamp != null) {
            message.addProperty("timestamp", timestamp);
        }
        return message;
    }

    private static boolean isProcessResult(JsonObject result) {
        JsonElement exit = result.get("exit_code");
        if (exit != null && !exit.isJsonNull() && integer(exit) == null) {
            return false;
        }
        JsonElement session = result.get("session_id");
        boolean running = session != null && session.isJsonPrimitive()
                && (session.getAsJsonPrimitive().isString() && !session.getAsString().isBlank()
                || integer(session) != null && session.getAsInt() > 0);
        return integer(exit) != null || running;
    }

    private static boolean isTerminal(JsonObject result) {
        return integer(result.get("exit_code")) != null;
    }

    private static Integer integer(JsonElement value) {
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            return null;
        }
        try {
            return value.getAsBigDecimal().intValueExact();
        } catch (ArithmeticException | NumberFormatException ignored) {
            return null;
        }
    }

    private static String command(JsonObject input) {
        String command = literalText(input, "cmd");
        if (command == null) {
            command = literalText(input, "command");
        }
        return command == null || command.isBlank() ? null : command;
    }

    private static JsonObject commandInput(JsonObject original, JsonObject nativeItem) {
        JsonObject input = original.deepCopy();
        String command = command(original);
        input.addProperty("command", command);
        if (nativeItem != null) {
            for (String field : List.of("description", "summary", "title", "justification", "approvalReason")) {
                String value = literalText(nativeItem, field);
                if (!input.has(field) && value != null && !value.isBlank()) {
                    input.addProperty(field, value);
                }
            }
            JsonElement actions = nativeItem.get("parsed_cmd");
            if (actions != null && actions.isJsonArray()) {
                // Recorded actions let the frontend use the same localized labels as live command items.
                input.add("commandActions", actions.deepCopy());
            }
        }
        String description = firstText(input, "description", "summary", "title");
        if (!description.isBlank()) {
            input.addProperty("description", description);
        }
        return input;
    }

    private static String firstText(JsonObject input, String... keys) {
        for (String key : keys) {
            String value = string(input, key);
            if (value != null) {
                return value;
            }
        }
        return "";
    }

    private static JsonObject parseObject(String text) {
        try {
            JsonElement parsed = JsonParser.parseString(text);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static String literalText(JsonObject value, String key) {
        JsonElement field = value == null ? null : value.get(key);
        return field != null && field.isJsonPrimitive() && field.getAsJsonPrimitive().isString() ? field.getAsString() : null;
    }

    private static JsonObject object(JsonObject value, String field) {
        return value != null && value.has(field) && value.get(field).isJsonObject() ? value.getAsJsonObject(field) : null;
    }

    private static String string(JsonObject value, String key) {
        return value == null ? null : HistoryMessageInjector.getStringProperty(value, key);
    }
}
