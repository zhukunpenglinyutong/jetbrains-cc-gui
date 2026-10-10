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
    private static final Pattern BATCH_VARIABLE = Pattern.compile(
            "(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*await\\s+Promise\\.all(?:Settled)?\\s*\\(\\s*$");
    private static final Pattern BATCH_CALLBACK = Pattern.compile(
            "^\\(\\s*\\(?\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)?\\s*=>");
    private static final Pattern INDEX_LABEL = Pattern.compile(
            "text\\(\\s*`([^`$\\\\]*)\\$\\{([A-Za-z_$][A-Za-z0-9_$]*)\\}([^`$\\\\]*)`\\s*\\)");
    private static final int MAX_CALLS = 100;
    private static final Pattern CLOCK_TIME = Pattern.compile("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} UTC");

    record Action(String kind, JsonObject input, int position, int resultIndex) { }
    record IndexLabel(Pattern pattern, boolean settledReceipt) { }
    record Process(String toolId, JsonObject metadata, String command) {
        Process(String toolId, JsonObject metadata) {
            this(toolId, metadata, null);
        }
    }

    private final JsonObject original;
    private final List<Action> actions;
    private final List<JsonObject> nativeRecords = new ArrayList<>();
    private final String rootThreadId;
    private final String turnId;
    private final IndexLabel resultIndexLabel;
    private boolean opaqueFallback;

    private CodexKnownExecReplay(JsonObject original, List<Action> actions, String rootThreadId) {
        this.original = original;
        this.actions = actions;
        this.rootThreadId = rootThreadId;
        this.turnId = string(object(object(original, "payload"), "internal_chat_message_metadata_passthrough"), "turn_id");
        JsonObject payload = object(original, "payload");
        this.resultIndexLabel = readIndexLabel(firstText(payload, "input", "arguments"));
    }

    static CodexKnownExecReplay begin(JsonObject record, String rootThreadId) {
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
        return actions == null || actions.isEmpty() ? null : new CodexKnownExecReplay(record, actions, rootThreadId);
    }

    JsonObject original() { return this.original; }
    List<JsonObject> nativeRecords() { return this.nativeRecords; }
    String callId() { return string(object(this.original, "payload"), "call_id"); }
    boolean keepsOriginalWrapper() { return this.opaqueFallback; }

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
        if (this.opaqueFallback || this.actions.stream().anyMatch(action -> action.kind.equals("apply_patch") && !action.input.has("patch"))) {
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
            block.addProperty("id", this.callId() + (isWeb(action.kind) ? ":web:" : isClock(action.kind) ? ":clock:" : ":command:") + index);
            block.addProperty("name", isMcp(action.kind) ? action.kind.substring(action.kind.lastIndexOf("__") + 2) : isWeb(action.kind) ? "webSearch"
                    : action.kind.equals("apply_patch") ? "apply_patch" : action.kind.equals("view_image") ? "imageView"
                    : isClock(action.kind) ? action.kind : "bash");
            JsonObject input = action.kind.equals("apply_patch") || action.kind.equals("view_image") || isWeb(action.kind) || isMcp(action.kind) || isClock(action.kind)
                    ? action.input.deepCopy() : commandInput(action.input);
            if (action.kind.equals("apply_patch")) {
                input.addProperty("status", "unknown");
            } else if (!action.kind.equals("view_image") && !isWeb(action.kind) && !isMcp(action.kind) && !isClock(action.kind)) {
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
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        if (!"event_msg".equals(string(record, "type")) || !"item_completed".equals(string(payload, "type"))
                || !List.of("FileChange", "CommandExecution", "ImageView", "McpToolCall").contains(String.valueOf(string(item, "type")))
                && !CodexRecordedWebSearch.isWebItem(item)
                || string(item, "id") == null) {
            return false;
        }
        String thread = string(payload, "thread_id");
        String turn = string(payload, "turn_id");
        if (this.rootThreadId != null && thread != null && !this.rootThreadId.equals(thread)
                || this.turnId != null && turn != null && !this.turnId.equals(turn)) {
            return true;
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
        }
        return true;
    }

    List<JsonObject> project(JsonObject outputRecord, Map<String, Process> processes) {
        this.opaqueFallback = false;
        JsonObject replayScope = this.recordedScope();
        if (replayScope == null) {
            return this.keepWrapperForReview();
        }
        JsonObject output = object(outputRecord, "payload");
        List<String> texts = new ArrayList<>();
        CodexExecHistoryReplay.collectOutputTexts(output == null ? null : output.get("output"), texts);
        List<JsonObject> stopped = this.restoreStoppedSequence(outputRecord, texts, replayScope, processes);
        if (stopped != null) {
            return stopped;
        }
        Map<Integer, JsonElement> indexed = new HashMap<>();
        List<JsonObject> direct = new ArrayList<>();
        List<JsonObject> clockReceipts = new ArrayList<>();
        Integer labeledIndex = null;
        for (String text : texts) {
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
            if (labeledIndex != null) {
                JsonElement result = value;
                if (this.resultIndexLabel.settledReceipt) {
                    result = "fulfilled".equals(string(value, "status")) ? value.get("value")
                            : "rejected".equals(string(value, "status")) ? rejectedResult(value.get("reason")) : null;
                }
                if (result == null || indexed.putIfAbsent(labeledIndex, result) != null) {
                    return this.keepWrapperForReview();
                }
                labeledIndex = null;
            } else if (value.has("i") || value.has("index")) {
                // Both envelopes occur in persisted wrappers; ignoring either replays native work twice.
                Integer index = integer(value.get(value.has("i") ? "i" : "index"));
                if (index == null || value.has("i") && value.has("index") && !index.equals(integer(value.get("index")))
                        || index < 0 || !this.hasResultIndex(index)) {
                    return this.keepWrapperForReview();
                }
                JsonElement result = unwrapIndexedResult(value);
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
        if (!direct.isEmpty() && directActions.size() > 1 && directActions.stream().anyMatch(action -> action.resultIndex >= 0)
                && directActions.stream().anyMatch(action -> action.kind.equals("write_stdin")
                || this.findNativeCommand(command(action.input), null, processes, new HashSet<>()) == null)) {
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
                String processId = string(item, "process_id");
                return "CommandExecution".equals(string(item, "type")) && command.equals(nativeCommand(item))
                        && (processId == null || !processes.containsKey(processId));
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
        List<JsonObject> messages = new ArrayList<>();
        Map<String, Process> nextProcesses = new LinkedHashMap<>(processes);
        int patchIndex = 0;
        int directIndex = 0;
        Set<String> usedNativeIds = new HashSet<>();
        for (int index = 0; index < this.actions.size(); index++) {
            Action action = this.actions.get(index);
            JsonElement indexedResult = action.resultIndex >= 0 ? indexed.get(action.resultIndex) : null;
            if (isRejected(indexedResult)) {
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
                        ? commandInput(action.input) : action.input.deepCopy();
                if (action.kind.equals("apply_patch")) {
                    input.addProperty("status", "failed");
                }
                tool.add("input", input);
                messages.add(message(this.original, replayScope, "assistant", id, tool));
                messages.add(resultMessage(outputRecord, new Process(id, replayScope), indexedResult.getAsJsonObject()));
                continue;
            }
            if (action.kind.equals("apply_patch")) {
                messages.addAll(CodexRecordedFileChange.readMessages(patches.get(patchIndex++)));
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
                JsonObject completion = this.findNativeProcessCompletion(sessionId, nextProcesses, usedNativeIds);
                if (this.opaqueFallback) {
                    return null;
                }
                if (completion != null) {
                    JsonObject item = object(object(completion, "payload"), "item");
                    if (process != null && (!nativeCommand(item).equals(process.command)
                            || !compatibleScope(process.metadata, metadata(completion, null, null)))) {
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
                } else if (process != null && result != null && isTerminal(result)) {
                    messages.add(resultMessage(outputRecord, process, result));
                    nextProcesses.remove(sessionId);
                }
                continue;
            }
            String command = command(action.input);
            JsonObject nativeRecord = this.findNativeCommand(command, string(result, "session_id"), nextProcesses, usedNativeIds);
            if (this.opaqueFallback) {
                return null;
            }
            String toolId = nativeRecord == null ? this.callId() + ":command:" + index
                    : string(object(object(nativeRecord, "payload"), "item"), "id");
            JsonObject metadata = nativeRecord == null ? replayScope : metadata(nativeRecord,
                    string(replayScope, "codexThreadId"), string(replayScope, "codexTurnId"));
            metadata.addProperty("codexReplayedCallId", this.callId());
            Process process = new Process(toolId, metadata, command);
            JsonObject input = commandInput(action.input);
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
        processes.clear();
        nextProcesses.forEach((id, process) -> {
            if (processes.size() < 256) {
                processes.put(id, process);
            }
        });
        return messages;
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
                    && command.equals(process.command) && compatibleScope(process.metadata, scope);
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
            tool.add("input", commandInput(input));
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
            CodexKnownExecReplay prefix = new CodexKnownExecReplay(this.original, this.actions.subList(0, end), this.rootThreadId);
            prefix.nativeRecords.addAll(this.nativeRecords);
            return prefix.project(output, processes);
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

    private static IndexLabel readIndexLabel(String script) {
        int arrayStart = groupStart(script);
        if (arrayStart < 0) {
            return null;
        }
        var variable = BATCH_VARIABLE.matcher(script.substring(0, arrayStart));
        if (!variable.find()) {
            return null;
        }
        String token = variable.group(1) + ".forEach";
        int callbackStart = CodexExecHistoryReplay.findJavaScriptToken(script, token, containerEnd(script, arrayStart) + 1);
        if (callbackStart < 0) {
            return null;
        }
        int paren = CodexExecHistoryReplay.skipTrivia(script, callbackStart + token.length(), script.length());
        if (paren >= script.length() || script.charAt(paren) != '(') {
            return null;
        }
        var callback = BATCH_CALLBACK.matcher(script.substring(paren));
        if (!callback.find()) {
            return null;
        }
        int callbackEnd = containerEnd(script, paren);
        if (callbackEnd <= paren) {
            return null;
        }
        var marker = INDEX_LABEL.matcher(script);
        marker.region(paren, callbackEnd);
        while (marker.find()) {
            if (!marker.group(2).equals(callback.group(2))
                    || CodexExecHistoryReplay.findJavaScriptToken(script, "text", marker.start()) != marker.start()) {
                continue;
            }
            int next = CodexExecHistoryReplay.skipTrivia(script, marker.end(), callbackEnd);
            if (next < callbackEnd && script.charAt(next) == ';') {
                next = CodexExecHistoryReplay.skipTrivia(script, next + 1, callbackEnd);
            }
            // A recorded label can own the receipt only when the callback prints that receipt next.
            String tail = script.substring(next, callbackEnd);
            if (Pattern.compile("^text\\(\\s*" + Pattern.quote(callback.group(1)) + "(?:\\.(?:status|value)\\b|\\s*\\))").matcher(tail).find()) {
                boolean wholeReceipt = Pattern.compile("^text\\(\\s*" + Pattern.quote(callback.group(1)) + "\\s*\\)").matcher(tail).find();
                return new IndexLabel(Pattern.compile(Pattern.quote(marker.group(1)) + "([0-9]+)" + Pattern.quote(marker.group(3))),
                        wholeReceipt && script.substring(variable.start(), arrayStart).contains("Promise.allSettled"));
            }
        }
        return null;
    }

    private static JsonElement unwrapIndexedResult(JsonObject value) {
        if (value.has("error") || "rejected".equals(string(value, "status"))) {
            return rejectedResult(value.has("error") ? value.get("error") : value.get("reason"));
        }
        JsonElement result = value.get("result");
        if (result == null) {
            return "fulfilled".equals(string(value, "status")) ? value.get("value") : null;
        }
        if (result.isJsonObject()) {
            JsonObject receipt = result.getAsJsonObject();
            String status = string(receipt, "status");
            if ("fulfilled".equals(status)) {
                return receipt.get("value");
            }
            if ("rejected".equals(status)) {
                return rejectedResult(receipt.get("reason"));
            }
        }
        // Condensed allSettled output carries the tool body directly under result.
        return result;
    }

    private static JsonObject rejectedResult(JsonElement reason) {
        JsonObject result = new JsonObject();
        result.addProperty("codexExecRejected", true);
        result.addProperty("is_error", true);
        result.addProperty("output", reason == null || reason.isJsonNull() ? ""
                : reason.isJsonPrimitive() ? reason.getAsString() : reason.toString());
        return result;
    }

    private static boolean isRejected(JsonElement result) {
        JsonObject value = result != null && result.isJsonObject() ? result.getAsJsonObject() : null;
        return value != null && value.has("codexExecRejected") && value.get("codexExecRejected").getAsBoolean();
    }

    private JsonObject recordedScope() {
        JsonObject scope = metadata(this.original, this.rootThreadId, this.turnId);
        for (JsonObject record : this.nativeRecords) {
            JsonObject payload = object(record, "payload");
            for (String field : List.of("thread", "turn")) {
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

    private JsonObject findNativeCommand(String command, String expectedProcessId, Map<String, Process> processes, Set<String> usedIds) {
        List<JsonObject> candidates = this.nativeRecords.stream().filter(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            String id = string(item, "id");
            String processId = string(item, "process_id");
            // A tracked process keeps its receipt even when the wrapper starts an identical command first.
            return "CommandExecution".equals(string(item, "type")) && id != null && !usedIds.contains(id)
                    && (processId == null || !processes.containsKey(processId)) && command.equals(nativeCommand(item))
                    && List.of("completed", "failed", "interrupted").contains(String.valueOf(string(item, "status")));
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

    private JsonObject findNativeProcessCompletion(String processId, Map<String, Process> processes, Set<String> usedIds) {
        List<JsonObject> candidates = this.nativeRecords.stream().filter(record -> {
            JsonObject item = object(object(record, "payload"), "item");
            String id = string(item, "id");
            return "CommandExecution".equals(string(item, "type")) && id != null && !usedIds.contains(id)
                    && nativeCommand(item) != null
                    && List.of("completed", "failed", "interrupted").contains(String.valueOf(string(item, "status")));
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

    private static List<Action> readActions(String script, JsonObject payload) {
        Set<String> tokens = new HashSet<>();
        var matcher = TOOL_TOKEN.matcher(script);
        while (matcher.find()) {
            tokens.add(matcher.group());
        }
        List<Action> actions = new ArrayList<>();
        List<String> patches = CodexExecHistoryReplay.extractPatches(payload);
        int patchCount = 0;
        int groupStart = groupStart(script);
        int groupEnd = groupStart < 0 ? -1 : containerEnd(script, groupStart);
        List<Integer> groupEntries = groupStart < 0 ? List.of() : groupEntries(script, groupStart, groupEnd);
        if (groupEntries == null) {
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
                JsonObject input;
                if (kind.equals("apply_patch")) {
                    input = new JsonObject();
                    patchCount++;
                } else {
                    int start = CodexExecHistoryReplay.skipTrivia(script, paren + 1, script.length());
                    if (start >= script.length() || script.charAt(start) != '{') {
                        return null;
                    }
                    int end = CodexExecHistoryReplay.findMatchingObjectEnd(script, start);
                    if (end < start) {
                        return null;
                    }
                    int after = CodexExecHistoryReplay.skipTrivia(script, end + 1, script.length());
                    if (after >= script.length() || script.charAt(after) != ')') {
                        return null;
                    }
                    String literal = CodexExecHistoryReplay.normalizeJavaScriptLiteralToJson(script.substring(start, end + 1));
                    input = literal == null ? null : parseObject(literal);
                    if (input == null || kind.equals("write_stdin") && (input.has("chars")
                            && literalText(input, "chars") == null || string(input, "session_id") == null)
                            || kind.equals("view_image") && string(input, "path") == null
                            || isClock(kind) && input.size() != 0
                            || !List.of("write_stdin", "view_image").contains(kind) && !isWeb(kind) && !isMcp(kind) && !isClock(kind) && command(input) == null) {
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
        // Array slots, rather than the number of discovered tools, own result indices.
        if (representedEntries.size() != groupEntries.size()) {
            return null;
        }
        return indexed;
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
        for (String token : List.of("Promise.allSettled", "Promise.all")) {
            int position = CodexExecHistoryReplay.findJavaScriptToken(script, token, 0);
            if (position < 0) {
                continue;
            }
            if (found >= 0 || CodexExecHistoryReplay.findJavaScriptToken(script, token, position + token.length()) >= 0) {
                return -1;
            }
            int paren = CodexExecHistoryReplay.skipTrivia(script, position + token.length(), script.length());
            int start = CodexExecHistoryReplay.skipTrivia(script, paren + 1, script.length());
            if (paren < script.length() && script.charAt(paren) == '(' && start < script.length() && script.charAt(start) == '[') {
                found = start;
            }
        }
        return found;
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

    private static JsonObject commandInput(JsonObject original) {
        JsonObject input = original.deepCopy();
        String command = command(original);
        input.addProperty("command", command);
        String description = firstText(original, "description", "summary", "title");
        input.addProperty("description", description.isBlank()
                ? CodexExecHistoryReplay.smartCommandDescription(command) : description);
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
