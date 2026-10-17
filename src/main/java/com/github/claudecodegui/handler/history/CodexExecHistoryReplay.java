package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Restores nested shell commands and plan updates persisted inside Codex
 * Responses API {@code exec} wrappers.
 *
 * <p>The live bridge receives command-execution events and renders them as
 * normal Bash tool cards. A cold history load instead sees the outer
 * JavaScript wrapper. This class statically reads object literals from that
 * wrapper without evaluating JavaScript, then recreates the same tool-use and
 * tool-result message shape used by the live bridge.</p>
 */
final class CodexExecHistoryReplay {

    private static final int MAX_REPLAYED_SHELL_COMMANDS = 100;
    private static final int MAX_REPLAYED_PLAN_ITEMS = 100;
    private static final String UPDATE_PLAN_TOKEN = "tools.update_plan";
    private static final List<String> PATCH_TOKENS = List.of("tools.apply_patch", "functions.apply_patch");
    private static final List<String> SHELL_TOKENS = List.of("tools.shell_command", "tools.exec_command");
    private static final Pattern TOOL_CALL_TOKEN = Pattern.compile("(?:tools|functions)\\.[A-Za-z_][A-Za-z0-9_]*");
    private static final Pattern JAVASCRIPT_NUMBER_PATTERN = Pattern.compile(
        "-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?"
    );
    private static final Pattern OUTPUT_MARKER_PATTERN = Pattern.compile(
        "(?m)^---(\\d+)---[\\t ]*\\r?$"
    );
    private static final Pattern FAILED_OUTPUT_PATTERN = Pattern.compile(
        "(?im)(?:exit[_ ]code|process exited with code)\\s*[=:]?\\s*-?[1-9]\\d*"
            + "|\"is_error\"\\s*:\\s*true|\\bscript (?:error|failed)\\b"
            + "|\\bpermission denied\\b"
    );
    private static final Pattern SHELL_WRAPPER_PATTERN = Pattern.compile(
        "^/bin/(?:zsh|bash)\\s+(?:-lc|-c)\\s+['\"](.+)['\"]$",
        Pattern.DOTALL
    );
    private static final Pattern CD_PREFIX_PATTERN = Pattern.compile(
        "^cd\\s+\\S+\\s+&&\\s+(.+)$",
        Pattern.DOTALL
    );

    private CodexExecHistoryReplay() {
    }

    static boolean isExecCall(JsonObject payload) {
        String name = getStringProperty(payload, "name");
        return "exec".equalsIgnoreCase(name) || "functions.exec".equalsIgnoreCase(name);
    }

    static boolean containsUnsupportedToolCalls(JsonObject payload) {
        String script = getStringProperty(payload, "input");
        if (script == null) {
            script = getStringProperty(payload, "arguments");
        }
        if (script == null) {
            return false;
        }
        Matcher matcher = TOOL_CALL_TOKEN.matcher(script);
        while (matcher.find()) {
            String token = matcher.group();
            if (!List.of("tools.shell_command", "tools.exec_command", UPDATE_PLAN_TOKEN,
                            "tools.apply_patch", "functions.apply_patch").contains(token)
                    && findJavaScriptToken(script, token, 0) >= 0) {
                return true;
            }
        }
        int patchCount = countCalls(script, PATCH_TOKENS);
        int shellCount = countCalls(script, SHELL_TOKENS);
        int planCount = countCalls(script, List.of(UPDATE_PLAN_TOKEN));
        // A combined wrapper result cannot prove which kind of tool succeeded.
        // Preserve it intact when replay would lose calls or invent attribution.
        if (patchCount > 1 || planCount > 1
                || (patchCount > 0 ? 1 : 0) + (shellCount > 0 ? 1 : 0) + (planCount > 0 ? 1 : 0) > 1) {
            return true;
        }
        if (patchCount != extractPatches(payload).size()
                || planCount > 0 && extractUpdatePlanInput(payload) == null) {
            return true;
        }
        return shellCount > 0 && !canReplayEveryShellCall(script, payload);
    }

    private static int countCalls(String script, List<String> tokens) {
        int count = 0;
        for (String token : tokens) {
            int cursor = 0;
            while ((cursor = findJavaScriptToken(script, token, cursor)) >= 0) {
                count++;
                cursor += token.length();
            }
        }
        return count;
    }

    private static boolean canReplayEveryShellCall(String script, JsonObject payload) {
        if (!findLiteralShellBatchSpans(script).isEmpty()) {
            return true;
        }
        int count = 0;
        for (String token : SHELL_TOKENS) {
            int cursor = 0;
            while ((cursor = findJavaScriptToken(script, token, cursor)) >= 0) {
                int paren = skipTrivia(script, cursor + token.length(), script.length());
                int start = skipTrivia(script, paren + 1, script.length());
                if (paren >= script.length() || script.charAt(paren) != '('
                        || start >= script.length() || script.charAt(start) != '{') {
                    return false;
                }
                int end = findMatchingObjectEnd(script, start);
                int next = skipTrivia(script, end + 1, script.length());
                if (end < start || next >= script.length() || script.charAt(next) != ')'
                        || parseJavaScriptObjectProperties(script, start, end).isEmpty()) {
                    return false;
                }
                count++;
                cursor += token.length();
            }
        }
        return count == extractCommands(payload).size();
    }

    static List<String> extractPatches(JsonObject payload) {
        String script = getStringProperty(payload, "input");
        if (script == null) {
            script = getStringProperty(payload, "arguments");
        }
        List<int[]> calls = new ArrayList<>();
        if (script == null) {
            return List.of();
        }
        for (String token : PATCH_TOKENS) {
            int cursor = 0;
            while ((cursor = findJavaScriptToken(script, token, cursor)) >= 0) {
                int paren = skipTrivia(script, cursor + token.length(), script.length());
                calls.add(new int[]{cursor, paren});
                cursor += token.length();
            }
        }
        calls.sort((left, right) -> Integer.compare(left[0], right[0]));
        List<String> patches = new ArrayList<>();
        for (int[] call : calls) {
            int paren = call[1];
            if (paren >= script.length() || script.charAt(paren) != '(') {
                continue;
            }
            int start = skipTrivia(script, paren + 1, script.length());
            if (start >= script.length()) {
                continue;
            }
            ParsedString literal;
            int argumentEnd;
            if (isQuote(script.charAt(start))) {
                literal = readLiteralString(script, start);
                argumentEnd = literal == null ? start : literal.nextIndex;
            } else {
                argumentEnd = start;
                while (argumentEnd < script.length() && isJavaScriptIdentifierPart(script.charAt(argumentEnd))) {
                    argumentEnd++;
                }
                literal = readLeadingLiteralBinding(script, script.substring(start, argumentEnd), start);
            }
            int end = skipTrivia(script, argumentEnd, script.length());
            if (end >= script.length() || script.charAt(end) != ')') {
                continue;
            }
            if (literal == null) {
                patches.addAll(readLiteralPatchBatch(script, script.substring(start, argumentEnd), call[0]));
                if (patches.size() >= MAX_REPLAYED_SHELL_COMMANDS) {
                    break;
                }
                continue;
            }
            String patch = literal.value.replace("\r\n", "\n").replace('\r', '\n').strip();
            if (patch.startsWith("*** Begin Patch\n") && patch.endsWith("*** End Patch")
                    && Pattern.compile("(?m)^\\*\\*\\* (?:Add|Update|Delete) File: .+").matcher(patch).find()) {
                patches.add(literal.value);
            }
            if (patches.size() >= MAX_REPLAYED_SHELL_COMMANDS) {
                break;
            }
        }
        return patches;
    }

    static boolean needsRecordedPatch(JsonObject payload) {
        String script = getStringProperty(payload, "input");
        if (script == null) {
            script = getStringProperty(payload, "arguments");
        }
        return script != null && countCalls(script, PATCH_TOKENS) > 0 && extractPatches(payload).isEmpty();
    }

    private static ParsedString readLiteralString(String script, int start) {
        ParsedString literal = readJavaScriptString(script, start);
        if (literal.nextIndex <= start + 1 || script.charAt(literal.nextIndex - 1) != script.charAt(start)
                || script.charAt(start) == '`' && containsTemplateInterpolation(script, start, literal.nextIndex)) {
            return null;
        }
        return literal;
    }

    private static ParsedString readLeadingLiteralBinding(String script, String name, int argumentStart) {
        if (name.isEmpty()) {
            return null;
        }
        int cursor = skipTrivia(script, 0, argumentStart);
        while (cursor < argumentStart && script.startsWith("const", cursor)) {
            int identifierStart = skipTrivia(script, cursor + "const".length(), argumentStart);
            int identifierEnd = identifierStart;
            while (identifierEnd < argumentStart && isJavaScriptIdentifierPart(script.charAt(identifierEnd))) {
                identifierEnd++;
            }
            int assignment = skipTrivia(script, identifierEnd, argumentStart);
            if (identifierEnd == identifierStart || assignment >= argumentStart || script.charAt(assignment) != '=') {
                return null;
            }
            int valueStart = skipTrivia(script, assignment + 1, argumentStart);
            if (valueStart >= argumentStart || !isQuote(script.charAt(valueStart))) {
                return null;
            }
            ParsedString literal = readLiteralString(script, valueStart);
            if (literal == null) {
                return null;
            }
            int end = skipTrivia(script, literal.nextIndex, argumentStart);
            if (end >= argumentStart || script.charAt(end) != ';') {
                return null;
            }
            if (name.equals(script.substring(identifierStart, identifierEnd))) {
                // An immutable leading literal is known without executing history.
                // Earlier references could shadow the binding or evaluate another value.
                return findJavaScriptToken(script, name, end + 1) == argumentStart ? literal : null;
            }
            cursor = skipTrivia(script, end + 1, argumentStart);
        }
        return null;
    }

    private static List<String> readLiteralPatchBatch(String script, String parameter, int callStart) {
        Matcher loop = Pattern.compile("\\bfor\\s*\\(\\s*const\\s+([A-Za-z_$][A-Za-z0-9_$]*)"
                + "\\s+of\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)\\s*(?:text\\(\\s*)?await\\s*$")
                .matcher(script.substring(0, callStart));
        if (!loop.find() || !parameter.equals(loop.group(1))) {
            return List.of();
        }
        int declarationStart = skipTrivia(script, 0, loop.start());
        Matcher declaration = Pattern.compile("const\\s+" + Pattern.quote(loop.group(2)) + "\\s*=\\s*").matcher(script);
        declaration.region(declarationStart, loop.start());
        if (!declaration.lookingAt() || declaration.end() >= script.length() || script.charAt(declaration.end()) != '[') {
            return List.of();
        }
        int start = declaration.end();
        int end = findMatchingEnd(script, start, '[', ']');
        int terminator = skipTrivia(script, end + 1, loop.start());
        if (end < start || terminator >= loop.start() || script.charAt(terminator) != ';'
                || skipTrivia(script, terminator + 1, loop.start()) != loop.start()) {
            return List.of();
        }
        // The array reaches the loop unchanged; mutations and computed entries
        // cannot establish the patch inputs without evaluating historical code.
        String normalized = normalizeJavaScriptLiteralToJson(script.substring(start, end + 1));
        if (normalized == null) {
            return List.of();
        }
        JsonElement value;
        try {
            value = JsonParser.parseString(normalized);
        } catch (RuntimeException ignored) {
            return List.of();
        }
        if (!value.isJsonArray() || value.getAsJsonArray().size() > MAX_REPLAYED_SHELL_COMMANDS) {
            return List.of();
        }
        List<String> patches = new ArrayList<>();
        for (JsonElement entry : value.getAsJsonArray()) {
            if (!entry.isJsonPrimitive() || !entry.getAsJsonPrimitive().isString()) {
                return List.of();
            }
            String patch = entry.getAsString().replace("\r\n", "\n").replace('\r', '\n').strip();
            if (!patch.startsWith("*** Begin Patch\n") || !patch.endsWith("*** End Patch")
                    || !Pattern.compile("(?m)^\\*\\*\\* (?:Add|Update|Delete) File: .+").matcher(patch).find()) {
                return List.of();
            }
            patches.add(entry.getAsString());
        }
        return patches;
    }

    static JsonObject createPatchToolUseMessage(String callId, String patch, int index, String timestamp) {
        JsonObject call = new JsonObject();
        call.addProperty("name", "apply_patch");
        call.addProperty("call_id", callId + ":patch:" + index);
        call.addProperty("input", patch);
        return CodexMessageConverter.convertCustomToolCallToToolUse(call, timestamp);
    }

    static JsonObject createPatchToolResultMessage(String callId, int index, Output output, String timestamp) {
        JsonObject result = output.payload.deepCopy();
        result.addProperty("call_id", callId + ":patch:" + index);
        if (isFailedOutputPayload(result) || FAILED_OUTPUT_PATTERN.matcher(result.toString()).find()) {
            result.addProperty("status", "error");
        }
        return CodexMessageConverter.convertCustomToolCallOutputToToolResult(result,
                output.timestamp == null ? timestamp : output.timestamp);
    }

    static List<Command> extractCommands(JsonObject payload) {
        String script = getStringProperty(payload, "input");
        if (script == null) {
            script = getStringProperty(payload, "arguments");
        }

        List<Command> commands = new ArrayList<>();
        if (script == null || script.isBlank()) {
            return commands;
        }

        List<int[]> objectSpans = new ArrayList<>();
        for (String token : SHELL_TOKENS) {
            int cursor = 0;
            while (cursor < script.length()) {
                int call = findJavaScriptToken(script, token, cursor);
                if (call < 0) {
                    break;
                }
                cursor = call + token.length();
                int paren = skipTrivia(script, cursor, script.length());
                if (paren >= script.length() || script.charAt(paren) != '(') {
                    continue;
                }
                int start = skipTrivia(script, paren + 1, script.length());
                if (start >= script.length() || script.charAt(start) != '{') {
                    continue;
                }
                int end = findMatchingObjectEnd(script, start);
                if (end >= start) {
                    objectSpans.add(new int[]{start, end});
                }
            }
        }
        // Older wrappers store a literal command batch and map it into the
        // shell tool. Preserve that established read-only projection too.
        if (objectSpans.isEmpty() && findJavaScriptToken(script, "tools.shell_command", 0) >= 0) {
            objectSpans.addAll(findLiteralShellBatchSpans(script));
        }
        objectSpans.sort((left, right) -> Integer.compare(left[0], right[0]));
        for (int[] span : objectSpans) {
            Map<String, String> properties =
                parseJavaScriptObjectProperties(script, span[0], span[1]);
            String command = properties.getOrDefault("command", properties.get("cmd"));
            if (command == null || command.isBlank()) {
                continue;
            }

            commands.add(new Command(
                command,
                firstExplanation(properties),
                properties.get("workdir"),
                parseLongOrNull(properties.get("timeout_ms")),
                properties.get("justification")
            ));
            if (commands.size() >= MAX_REPLAYED_SHELL_COMMANDS) {
                break;
            }
        }
        return commands;
    }

    private static String firstExplanation(Map<String, String> properties) {
        for (String key : List.of("description", "summary", "title")) {
            String value = properties.get(key);
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    static JsonObject extractUpdatePlanInput(JsonObject payload) {
        String script = getStringProperty(payload, "input");
        if (script == null) {
            script = getStringProperty(payload, "arguments");
        }
        if (script == null || script.isBlank()) {
            return null;
        }

        JsonObject latestPlan = null;
        int searchStart = 0;
        while (searchStart < script.length()) {
            int callStart = findJavaScriptToken(script, UPDATE_PLAN_TOKEN, searchStart);
            if (callStart < 0) {
                break;
            }
            int invocationStart = skipTrivia(
                script,
                callStart + UPDATE_PLAN_TOKEN.length(),
                script.length()
            );
            if (invocationStart < script.length() && script.charAt(invocationStart) == '(') {
                latestPlan = parseUpdatePlanCall(script, callStart);
            }
            searchStart = callStart + UPDATE_PLAN_TOKEN.length();
        }
        return latestPlan;
    }

    static JsonObject createPlanToolUseMessage(
            String callId,
            JsonObject planInput,
            String timestamp
    ) {
        JsonObject functionCall = new JsonObject();
        functionCall.addProperty("name", "update_plan");
        functionCall.addProperty("call_id", planToolUseId(callId));
        functionCall.addProperty("arguments", planInput.toString());
        return CodexMessageConverter.convertFunctionCallToToolUse(functionCall, timestamp);
    }

    static JsonObject createPlanToolResultMessage(
            String callId,
            Output output,
            String fallbackTimestamp
    ) {
        boolean failed = isFailedOutputPayload(output.payload)
            || FAILED_OUTPUT_PATTERN.matcher(output.payload.toString()).find();
        JsonObject functionOutput = new JsonObject();
        functionOutput.addProperty("call_id", planToolUseId(callId));
        functionOutput.addProperty("output", failed ? "Plan update failed" : "Plan updated");
        if (failed) {
            functionOutput.addProperty("status", "error");
        }
        String timestamp = output.timestamp != null ? output.timestamp : fallbackTimestamp;
        return CodexMessageConverter.convertFunctionCallOutputToToolResult(functionOutput, timestamp);
    }

    static JsonObject createToolUseMessage(
            String callId,
            List<Command> commands,
            String timestamp
    ) {
        JsonArray content = new JsonArray();
        for (int i = 0; i < commands.size(); i++) {
            Command command = commands.get(i);
            JsonObject input = new JsonObject();
            input.addProperty("command", command.command);
            input.addProperty(
                "description",
                command.description != null && !command.description.isBlank()
                    ? command.description
                    : smartCommandDescription(command.command)
            );
            if (command.workdir != null && !command.workdir.isBlank()) {
                input.addProperty("workdir", command.workdir);
            }
            if (command.timeoutMs != null) {
                input.addProperty("timeout_ms", command.timeoutMs);
            }
            if (command.justification != null && !command.justification.isBlank()) {
                input.addProperty("justification", command.justification);
            }

            JsonObject toolUse = new JsonObject();
            toolUse.addProperty("type", "tool_use");
            toolUse.addProperty("id", shellToolUseId(callId, i));
            toolUse.addProperty("name", smartShellToolName(command.command));
            toolUse.add("input", input);
            content.add(toolUse);
        }

        JsonObject raw = new JsonObject();
        raw.addProperty("role", "assistant");
        raw.add("content", content);

        JsonObject message = new JsonObject();
        message.addProperty("type", "assistant");
        message.addProperty("content", "");
        message.add("raw", raw);
        if (timestamp != null) {
            message.addProperty("timestamp", timestamp);
        }
        return message;
    }

    static JsonObject createToolResultMessage(
            String callId,
            List<Command> commands,
            Output output,
            String fallbackTimestamp
    ) {
        List<String> commandOutputs = splitShellCommandOutputs(output.payload, commands.size());
        boolean globalFailure = isFailedOutputPayload(output.payload);
        JsonArray content = new JsonArray();
        for (int i = 0; i < commands.size(); i++) {
            String commandOutput = i < commandOutputs.size()
                ? commandOutputs.get(i)
                : "(no output)";
            if (commandOutput == null || commandOutput.isBlank()) {
                commandOutput = "(no output)";
            }

            JsonObject toolResult = new JsonObject();
            toolResult.addProperty("type", "tool_result");
            toolResult.addProperty("tool_use_id", shellToolUseId(callId, i));
            JsonObject commandPayload = new JsonObject();
            commandPayload.addProperty("output", commandOutput);
            toolResult.addProperty(
                "is_error",
                isFailedOutputPayload(commandPayload) || FAILED_OUTPUT_PATTERN.matcher(commandOutput).find()
                    || (globalFailure && commands.size() == 1)
            );
            toolResult.addProperty("content", commandOutput);
            content.add(toolResult);
        }

        JsonObject raw = new JsonObject();
        raw.addProperty("role", "user");
        raw.add("content", content);

        JsonObject message = new JsonObject();
        message.addProperty("type", "user");
        message.addProperty("content", "[tool_result]");
        message.add("raw", raw);
        String timestamp = output.timestamp != null ? output.timestamp : fallbackTimestamp;
        if (timestamp != null) {
            message.addProperty("timestamp", timestamp);
        }
        return message;
    }

    private static List<int[]> findJavaScriptObjectSpans(String script) {
        List<int[]> spans = new ArrayList<>();
        List<Integer> stack = new ArrayList<>();
        int cursor = 0;
        while (cursor < script.length()) {
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                cursor = skipJavaScriptString(script, cursor);
                continue;
            }
            if (current == '/' && cursor + 1 < script.length()) {
                char next = script.charAt(cursor + 1);
                if (next == '/') {
                    cursor = skipLineComment(script, cursor + 2);
                    continue;
                }
                if (next == '*') {
                    cursor = skipBlockComment(script, cursor + 2);
                    continue;
                }
            }
            if (current == '{') {
                stack.add(cursor);
            } else if (current == '}' && !stack.isEmpty()) {
                int start = stack.remove(stack.size() - 1);
                spans.add(new int[]{start, cursor});
            }
            cursor++;
        }
        return spans;
    }

    private static List<int[]> findLiteralShellBatchSpans(String script) {
        if (countCalls(script, SHELL_TOKENS) != 1 || findJavaScriptToken(script, "tools.exec_command", 0) >= 0) {
            return List.of();
        }
        int call = findJavaScriptToken(script, "tools.shell_command", 0);
        if (call < 0) {
            return List.of();
        }
        Matcher mapping = Pattern.compile("([A-Za-z_$][A-Za-z0-9_$]*)\\.map\\(\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*=>\\s*$")
                .matcher(script.substring(0, call));
        if (!mapping.find()) {
            return List.of();
        }
        String batchName = mapping.group(1);
        String parameter = mapping.group(2);
        String tail = script.substring(call + "tools.shell_command".length());
        if (!Pattern.compile("^\\(\\s*" + Pattern.quote(parameter) + "\\s*\\)\\s*\\)").matcher(tail).find()) {
            return List.of();
        }
        Matcher declaration = Pattern.compile("\\bconst\\s+" + Pattern.quote(batchName) + "\\s*=\\s*(\\[)").matcher(script);
        if (!declaration.find()) {
            return List.of();
        }
        int start = declaration.start(1);
        if (findJavaScriptToken(script, script.substring(declaration.start(), start), 0) != declaration.start()) {
            return List.of();
        }
        int end = findMatchingEnd(script, start, '[', ']');
        if (end < start || end >= mapping.start()) {
            return List.of();
        }
        // Only a literal array passed unchanged to the mapped parameter is
        // known. Mutations and unrelated command-looking objects stay opaque.
        String between = script.substring(end + 1, mapping.start());
        if (Pattern.compile("\\b" + Pattern.quote(batchName) + "\\b").matcher(between).find()) {
            return List.of();
        }
        String normalized = normalizeJavaScriptLiteralToJson(script.substring(start, end + 1));
        if (normalized == null) {
            return List.of();
        }
        JsonElement literal;
        try {
            literal = JsonParser.parseString(normalized);
        } catch (RuntimeException ignored) {
            return List.of();
        }
        if (!literal.isJsonArray() || literal.getAsJsonArray().isEmpty()
                || literal.getAsJsonArray().size() > MAX_REPLAYED_SHELL_COMMANDS) {
            return List.of();
        }
        List<int[]> spans = findJavaScriptObjectSpans(script.substring(start, end + 1));
        if (spans.size() != literal.getAsJsonArray().size()) {
            return List.of();
        }
        for (int[] span : spans) {
            span[0] += start;
            span[1] += start;
            Map<String, String> properties = parseJavaScriptObjectProperties(script, span[0], span[1]);
            String command = properties.getOrDefault("command", properties.get("cmd"));
            if (command == null || command.isBlank()) {
                return List.of();
            }
        }
        return spans;
    }

    private static JsonObject parseUpdatePlanCall(String script, int callStart) {
        int cursor = skipTrivia(script, callStart + UPDATE_PLAN_TOKEN.length(), script.length());
        if (cursor >= script.length() || script.charAt(cursor) != '(') {
            return null;
        }
        cursor = skipTrivia(script, cursor + 1, script.length());
        if (cursor >= script.length() || script.charAt(cursor) != '{') {
            return null;
        }

        int objectEnd = findMatchingObjectEnd(script, cursor);
        if (objectEnd < 0) {
            return null;
        }

        String normalizedLiteral = normalizeJavaScriptLiteralToJson(
            script.substring(cursor, objectEnd + 1)
        );
        if (normalizedLiteral == null) {
            return null;
        }

        JsonObject inputObject;
        try {
            JsonElement parsed = JsonParser.parseString(normalizedLiteral);
            if (!parsed.isJsonObject()) {
                return null;
            }
            inputObject = parsed.getAsJsonObject();
        } catch (RuntimeException ignored) {
            return null;
        }
        if (!inputObject.has("plan") || !inputObject.get("plan").isJsonArray()) {
            return null;
        }

        JsonArray plan = new JsonArray();
        for (JsonElement planItem : inputObject.getAsJsonArray("plan")) {
            if (!planItem.isJsonObject()) {
                continue;
            }
            JsonObject itemObject = planItem.getAsJsonObject();
            String content = firstNonBlankString(itemObject, "content", "step", "title", "text");
            if (content == null) {
                continue;
            }

            JsonObject item = new JsonObject();
            item.addProperty("step", content);
            item.addProperty("status", normalizePlanStatus(itemObject.get("status")));
            plan.add(item);
            if (plan.size() >= MAX_REPLAYED_PLAN_ITEMS) {
                break;
            }
        }

        JsonObject input = new JsonObject();
        if (inputObject.has("explanation") && inputObject.get("explanation").isJsonPrimitive()
                && inputObject.getAsJsonPrimitive("explanation").isString()) {
            input.add("explanation", inputObject.get("explanation"));
        }
        input.add("plan", plan);
        return input;
    }

    static String normalizeJavaScriptLiteralToJson(String literal) {
        StringBuilder normalized = new StringBuilder(literal.length());
        int cursor = 0;
        while (cursor < literal.length()) {
            char current = literal.charAt(cursor);
            if (Character.isWhitespace(current)) {
                normalized.append(current);
                cursor++;
                continue;
            }
            if (current == '/' && cursor + 1 < literal.length()) {
                char next = literal.charAt(cursor + 1);
                if (next == '/') {
                    cursor = skipLineComment(literal, cursor + 2);
                    continue;
                }
                if (next == '*') {
                    cursor = skipBlockComment(literal, cursor + 2);
                    continue;
                }
                return null;
            }
            if (isQuote(current)) {
                int stringStart = cursor;
                ParsedString parsed = readJavaScriptString(literal, cursor);
                if (parsed.nextIndex <= stringStart + 1
                        || literal.charAt(parsed.nextIndex - 1) != current
                        || (current == '`' && containsTemplateInterpolation(
                            literal,
                            stringStart,
                            parsed.nextIndex
                        ))) {
                    return null;
                }
                normalized.append(new JsonPrimitive(parsed.value));
                cursor = parsed.nextIndex;
                continue;
            }
            if (isJavaScriptIdentifierStart(current)) {
                int identifierEnd = cursor + 1;
                while (identifierEnd < literal.length()
                        && isJavaScriptIdentifierPart(literal.charAt(identifierEnd))) {
                    identifierEnd++;
                }
                String identifier = literal.substring(cursor, identifierEnd);
                int nextToken = skipTrivia(literal, identifierEnd, literal.length());
                if (nextToken < literal.length() && literal.charAt(nextToken) == ':') {
                    normalized.append(new JsonPrimitive(identifier));
                } else if ("true".equals(identifier)
                        || "false".equals(identifier)
                        || "null".equals(identifier)) {
                    normalized.append(identifier);
                } else if ("undefined".equals(identifier)) {
                    normalized.append("null");
                } else {
                    return null;
                }
                cursor = identifierEnd;
                continue;
            }

            Matcher numberMatcher = JAVASCRIPT_NUMBER_PATTERN.matcher(literal);
            numberMatcher.region(cursor, literal.length());
            if (numberMatcher.lookingAt()) {
                normalized.append(numberMatcher.group());
                cursor = numberMatcher.end();
                continue;
            }
            if (current == ',') {
                int nextToken = skipTrivia(literal, cursor + 1, literal.length());
                if (nextToken < literal.length()
                        && (literal.charAt(nextToken) == '}' || literal.charAt(nextToken) == ']')) {
                    cursor++;
                    continue;
                }
            }
            if (current != '{' && current != '}' && current != '[' && current != ']'
                    && current != ':' && current != ',') {
                return null;
            }
            normalized.append(current);
            cursor++;
        }
        return normalized.toString();
    }

    private static boolean containsTemplateInterpolation(String source, int start, int end) {
        for (int cursor = start + 1; cursor + 1 < end; cursor++) {
            char current = source.charAt(cursor);
            if (current == '\\') {
                cursor++;
            } else if (current == '$' && source.charAt(cursor + 1) == '{') {
                return true;
            }
        }
        return false;
    }

    static int findMatchingObjectEnd(String script, int objectStart) {
        return findMatchingEnd(script, objectStart, '{', '}');
    }

    private static int findMatchingEnd(String script, int objectStart, char opening, char closing) {
        int depth = 0;
        int cursor = objectStart;
        while (cursor < script.length()) {
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                cursor = skipJavaScriptString(script, cursor);
                continue;
            }
            if (current == '/' && cursor + 1 < script.length()) {
                char next = script.charAt(cursor + 1);
                if (next == '/') {
                    cursor = skipLineComment(script, cursor + 2);
                    continue;
                }
                if (next == '*') {
                    cursor = skipBlockComment(script, cursor + 2);
                    continue;
                }
            }
            if (current == opening) {
                depth++;
            } else if (current == closing) {
                depth--;
                if (depth == 0) {
                    return cursor;
                }
            }
            cursor++;
        }
        return -1;
    }

    static int findJavaScriptToken(String script, String token, int start) {
        int cursor = Math.max(0, start);
        while (cursor < script.length()) {
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                cursor = skipJavaScriptString(script, cursor);
                continue;
            }
            if (current == '/' && cursor + 1 < script.length()) {
                char next = script.charAt(cursor + 1);
                if (next == '/') {
                    cursor = skipLineComment(script, cursor + 2);
                    continue;
                }
                if (next == '*') {
                    cursor = skipBlockComment(script, cursor + 2);
                    continue;
                }
            }
            if (script.startsWith(token, cursor)) {
                char before = cursor > 0 ? script.charAt(cursor - 1) : '\0';
                int afterIndex = cursor + token.length();
                char after = afterIndex < script.length() ? script.charAt(afterIndex) : '\0';
                if (!isJavaScriptIdentifierPart(before)
                        && before != '.'
                        && !isJavaScriptIdentifierPart(after)) {
                    return cursor;
                }
            }
            cursor++;
        }
        return -1;
    }

    private static String firstNonBlankString(JsonObject values, String... keys) {
        for (String key : keys) {
            JsonElement value = values.get(key);
            if (value != null && value.isJsonPrimitive()
                    && value.getAsJsonPrimitive().isString()
                    && !value.getAsString().isBlank()) {
                String text = value.getAsString();
                return text.trim();
            }
        }
        return null;
    }

    private static String normalizePlanStatus(JsonElement status) {
        if (status == null || !status.isJsonPrimitive() || !status.getAsJsonPrimitive().isString()) {
            return "pending";
        }
        String normalized = status.getAsString().trim().toLowerCase(Locale.ROOT);
        if ("completed".equals(normalized) || "done".equals(normalized)) {
            return "completed";
        }
        if ("in_progress".equals(normalized)
                || "in-progress".equals(normalized)
                || "active".equals(normalized)
                || "running".equals(normalized)) {
            return "in_progress";
        }
        return "pending";
    }

    private static Map<String, String> parseJavaScriptObjectProperties(
            String script,
            int objectStart,
            int objectEnd
    ) {
        Map<String, String> properties = new HashMap<>();
        int cursor = objectStart + 1;
        while (cursor < objectEnd) {
            cursor = skipWhitespaceAndCommas(script, cursor, objectEnd);
            if (cursor >= objectEnd) {
                break;
            }

            ParsedString key;
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                key = readJavaScriptString(script, cursor);
            } else if (isJavaScriptIdentifierStart(current)) {
                int keyEnd = cursor + 1;
                while (keyEnd < objectEnd && isJavaScriptIdentifierPart(script.charAt(keyEnd))) {
                    keyEnd++;
                }
                key = new ParsedString(script.substring(cursor, keyEnd), keyEnd);
            } else {
                return Map.of();
            }

            if (properties.containsKey(key.value)) {
                return Map.of();
            }

            cursor = skipWhitespace(script, key.nextIndex, objectEnd);
            if (cursor >= objectEnd || script.charAt(cursor) != ':') {
                int comma = findNextTopLevelComma(script, cursor, objectEnd);
                cursor = advancePastComma(comma, objectEnd);
                continue;
            }
            cursor = skipWhitespace(script, cursor + 1, objectEnd);
            if (cursor >= objectEnd) {
                break;
            }

            String propertyValue;
            current = script.charAt(cursor);
            if (isQuote(current)) {
                int literalStart = cursor;
                ParsedString parsedValue = readJavaScriptString(script, cursor);
                propertyValue = parsedValue.value;
                cursor = parsedValue.nextIndex;
                int next = skipTrivia(script, cursor, objectEnd);
                if ((current == '`' && script.substring(literalStart, cursor).contains("${"))
                        || (next < objectEnd && script.charAt(next) != ',')) {
                    cursor = advancePastComma(findNextTopLevelComma(script, next, objectEnd), objectEnd);
                    continue;
                }
            } else {
                int valueEnd = findNextTopLevelComma(script, cursor, objectEnd);
                propertyValue = script.substring(cursor, valueEnd).trim();
                cursor = valueEnd;
                if (!JAVASCRIPT_NUMBER_PATTERN.matcher(propertyValue).matches()) {
                    cursor = advancePastComma(cursor, objectEnd);
                    continue;
                }
            }
            properties.put(key.value, propertyValue);
            cursor = advancePastComma(cursor, objectEnd);
        }
        return properties;
    }

    private static int findNextTopLevelComma(String script, int start, int limit) {
        int braceDepth = 0;
        int bracketDepth = 0;
        int parenthesisDepth = 0;
        int cursor = Math.max(0, start);
        while (cursor < limit) {
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                cursor = skipJavaScriptString(script, cursor);
                continue;
            }
            if (current == '/' && cursor + 1 < limit) {
                char next = script.charAt(cursor + 1);
                if (next == '/') {
                    cursor = skipLineComment(script, cursor + 2);
                    continue;
                }
                if (next == '*') {
                    cursor = skipBlockComment(script, cursor + 2);
                    continue;
                }
            }
            if (current == '{') {
                braceDepth++;
            } else if (current == '}' && braceDepth > 0) {
                braceDepth--;
            } else if (current == '[') {
                bracketDepth++;
            } else if (current == ']' && bracketDepth > 0) {
                bracketDepth--;
            } else if (current == '(') {
                parenthesisDepth++;
            } else if (current == ')' && parenthesisDepth > 0) {
                parenthesisDepth--;
            } else if (current == ',' && braceDepth == 0
                    && bracketDepth == 0 && parenthesisDepth == 0) {
                return cursor;
            }
            cursor++;
        }
        return limit;
    }

    private static int advancePastComma(int cursor, int limit) {
        return cursor < limit ? cursor + 1 : cursor;
    }

    static int skipJavaScriptString(String script, int start) {
        char quote = script.charAt(start);
        int cursor = start + 1;
        while (cursor < script.length()) {
            char current = script.charAt(cursor++);
            if (current == '\\' && cursor < script.length()) {
                cursor++;
            } else if (current == quote) {
                break;
            }
        }
        return cursor;
    }

    private static ParsedString readJavaScriptString(String script, int start) {
        char quote = script.charAt(start);
        StringBuilder decoded = new StringBuilder();
        int cursor = start + 1;
        while (cursor < script.length()) {
            char current = script.charAt(cursor++);
            if (current == quote) {
                break;
            }
            if (current != '\\' || cursor >= script.length()) {
                decoded.append(current);
                continue;
            }

            char escaped = script.charAt(cursor++);
            switch (escaped) {
                case 'n':
                    decoded.append('\n');
                    break;
                case 'r':
                    decoded.append('\r');
                    break;
                case 't':
                    decoded.append('\t');
                    break;
                case 'b':
                    decoded.append('\b');
                    break;
                case 'f':
                    decoded.append('\f');
                    break;
                case 'v':
                    decoded.append('\u000B');
                    break;
                case '0':
                    decoded.append('\u0000');
                    break;
                case 'x':
                    cursor = appendHexEscape(script, cursor, 2, escaped, decoded);
                    break;
                case 'u':
                    cursor = appendHexEscape(script, cursor, 4, escaped, decoded);
                    break;
                case '\r':
                    if (cursor < script.length() && script.charAt(cursor) == '\n') {
                        cursor++;
                    }
                    break;
                case '\n':
                    break;
                default:
                    decoded.append(escaped);
                    break;
            }
        }
        return new ParsedString(decoded.toString(), cursor);
    }

    private static int appendHexEscape(
            String script,
            int start,
            int length,
            char escaped,
            StringBuilder decoded
    ) {
        int end = start + length;
        if (end <= script.length()) {
            try {
                decoded.append((char) Integer.parseInt(script.substring(start, end), 16));
                return end;
            } catch (NumberFormatException ignored) {
                // Preserve the escape marker when the sequence is malformed.
            }
        }
        decoded.append(escaped);
        return start;
    }

    private static int skipLineComment(String script, int start) {
        int cursor = start;
        while (cursor < script.length() && script.charAt(cursor) != '\n') {
            cursor++;
        }
        return cursor;
    }

    private static int skipBlockComment(String script, int start) {
        int end = script.indexOf("*/", start);
        return end >= 0 ? end + 2 : script.length();
    }

    static int skipTrivia(String script, int start, int limit) {
        int cursor = start;
        while (cursor < limit) {
            char current = script.charAt(cursor);
            if (Character.isWhitespace(current)) {
                cursor++;
                continue;
            }
            if (current == '/' && cursor + 1 < limit) {
                char next = script.charAt(cursor + 1);
                if (next == '/') {
                    cursor = Math.min(skipLineComment(script, cursor + 2), limit);
                    continue;
                }
                if (next == '*') {
                    cursor = Math.min(skipBlockComment(script, cursor + 2), limit);
                    continue;
                }
            }
            break;
        }
        return cursor;
    }

    private static int skipWhitespaceAndCommas(String script, int start, int limit) {
        int cursor = start;
        while (cursor < limit) {
            char current = script.charAt(cursor);
            if (!Character.isWhitespace(current) && current != ',') {
                break;
            }
            cursor++;
        }
        return cursor;
    }

    private static int skipWhitespace(String script, int start, int limit) {
        int cursor = start;
        while (cursor < limit && Character.isWhitespace(script.charAt(cursor))) {
            cursor++;
        }
        return cursor;
    }

    private static boolean isQuote(char value) {
        return value == '\'' || value == '"' || value == '`';
    }

    private static boolean isJavaScriptIdentifierStart(char value) {
        return Character.isLetter(value) || value == '_' || value == '$';
    }

    private static boolean isJavaScriptIdentifierPart(char value) {
        return Character.isLetterOrDigit(value) || value == '_' || value == '$';
    }

    private static Long parseLongOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static List<String> splitShellCommandOutputs(JsonObject outputPayload, int commandCount) {
        List<String> texts = new ArrayList<>();
        if (outputPayload != null && outputPayload.has("output")) {
            collectOutputTexts(outputPayload.get("output"), texts);
        }

        List<String> outputs = new ArrayList<>();
        for (int i = 0; i < commandCount; i++) {
            outputs.add("(no output)");
        }
        if (texts.isEmpty() || commandCount == 0) {
            return outputs;
        }

        String combined = String.join("\n", texts);
        Matcher markerMatcher = OUTPUT_MARKER_PATTERN.matcher(combined);
        int previousCommandIndex = -1;
        int previousContentStart = -1;
        boolean foundMarker = false;
        while (markerMatcher.find()) {
            foundMarker = true;
            if (previousCommandIndex >= 0 && previousCommandIndex < commandCount) {
                outputs.set(
                    previousCommandIndex,
                    normalizeCommandOutput(
                        combined.substring(previousContentStart, markerMatcher.start())
                    )
                );
            }
            previousCommandIndex = Integer.parseInt(markerMatcher.group(1)) - 1;
            previousContentStart = markerMatcher.end();
        }
        if (foundMarker) {
            if (previousCommandIndex >= 0 && previousCommandIndex < commandCount) {
                outputs.set(
                    previousCommandIndex,
                    normalizeCommandOutput(combined.substring(previousContentStart))
                );
            }
            return outputs;
        }

        List<String> actualTexts = new ArrayList<>(texts);
        if (actualTexts.size() > 1 && isExecWrapperStatus(actualTexts.get(0))) {
            actualTexts.remove(0);
        }
        if (commandCount == 1) {
            outputs.set(0, normalizeCommandOutput(String.join("\n", actualTexts)));
            return outputs;
        }

        if (actualTexts.size() >= commandCount) {
            for (int i = 0; i < commandCount; i++) {
                outputs.set(i, normalizeCommandOutput(actualTexts.get(i)));
            }
        } else {
            outputs.set(0, normalizeCommandOutput(String.join("\n", actualTexts)));
        }
        return outputs;
    }

    static void collectOutputTexts(JsonElement value, List<String> texts) {
        if (value == null || value.isJsonNull()) {
            return;
        }
        if (value.isJsonArray()) {
            for (JsonElement child : value.getAsJsonArray()) {
                collectOutputTexts(child, texts);
            }
            return;
        }
        if (value.isJsonObject()) {
            JsonObject object = value.getAsJsonObject();
            if (object.has("text") && object.get("text").isJsonPrimitive()) {
                texts.add(object.get("text").getAsString());
            } else if (object.has("content")) {
                collectOutputTexts(object.get("content"), texts);
            } else if (object.has("output")) {
                collectOutputTexts(object.get("output"), texts);
            }
            return;
        }
        if (!value.isJsonPrimitive()) {
            return;
        }

        String text = value.getAsString();
        String trimmed = text.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            try {
                JsonElement parsed = JsonParser.parseString(trimmed);
                if (isStructuredTextOutput(parsed)) {
                    collectOutputTexts(parsed, texts);
                    return;
                }
            } catch (Exception ignored) {
                // Treat ordinary command output beginning with '[' as plain text.
            }
        }
        texts.add(text);
    }

    private static boolean isStructuredTextOutput(JsonElement value) {
        if (!value.isJsonArray()) {
            return false;
        }
        for (JsonElement child : value.getAsJsonArray()) {
            if (child.isJsonObject() && child.getAsJsonObject().has("text")) {
                return true;
            }
        }
        return false;
    }

    private static String normalizeCommandOutput(String output) {
        String normalized = output == null ? "" : output.strip();
        return normalized.isEmpty() ? "(no output)" : normalized;
    }

    private static boolean isExecWrapperStatus(String text) {
        if (text == null) {
            return false;
        }
        String normalized = text.stripLeading().toLowerCase(Locale.ROOT);
        return normalized.startsWith("script completed")
            || normalized.startsWith("script failed")
            || normalized.startsWith("script running");
    }

    private static boolean isFailedOutputPayload(JsonObject output) {
        return CodexMessageConverter.isFailedToolOutput(output);
    }

    private static String shellToolUseId(String callId, int commandIndex) {
        String stableCallId = callId == null || callId.isBlank() ? "unknown" : callId;
        return "codex_exec_" + stableCallId + "_" + commandIndex;
    }

    private static String planToolUseId(String callId) {
        String stableCallId = callId == null || callId.isBlank() ? "unknown" : callId;
        return "codex_plan_" + stableCallId;
    }

    private static String smartShellToolName(String command) {
        String actualCommand = extractActualCommand(command);
        if (actualCommand.matches("^(ls|find|tree)\\b.*")) {
            return "glob";
        }
        if (actualCommand.matches("^(pwd|cat|head|tail|file|stat)\\b.*")
                || actualCommand.matches("^sed\\s+-n\\s+.*")) {
            return "read";
        }
        if (actualCommand.matches("^(grep|rg|ack|ag)\\b.*")) {
            return "glob";
        }
        return "bash";
    }

    static String smartCommandDescription(String command) {
        if (command == null || command.isBlank()) {
            return "Execute command";
        }
        String actualCommand = extractActualCommand(command);
        String[] words = actualCommand.split("\\s+");
        String firstWord = words.length > 0 ? words[0] : actualCommand;

        if (actualCommand.matches("^ls\\b.*")) {
            return "List directory contents";
        }
        if (actualCommand.matches("^pwd\\b.*")) {
            return "Show current directory";
        }
        if (actualCommand.matches("^cat\\b.*")) {
            return "Read file contents";
        }
        if (actualCommand.matches("^head\\b.*")) {
            return "Read first lines";
        }
        if (actualCommand.matches("^tail\\b.*")) {
            return "Read last lines";
        }
        if (actualCommand.matches("^find\\b.*")) {
            return "Find files";
        }
        if (actualCommand.matches("^tree\\b.*")) {
            return "Show directory tree";
        }
        if (actualCommand.matches("^sed\\s+-n\\s+.*")) {
            return "Read file lines";
        }
        if (actualCommand.matches("^(grep|rg|ack|ag)\\b.*")) {
            return "Search in files";
        }
        if (actualCommand.matches("^git\\s+status\\b.*")) {
            return "Check git status";
        }
        if (actualCommand.matches("^git\\s+diff\\b.*")) {
            return "Show git diff";
        }
        if (actualCommand.matches("^git\\s+log\\b.*")) {
            return "Show git log";
        }
        if (actualCommand.matches("^git\\s+add\\b.*")) {
            return "Stage changes";
        }
        if (actualCommand.matches("^git\\s+commit\\b.*")) {
            return "Commit changes";
        }
        if (actualCommand.matches("^git\\s+push\\b.*")) {
            return "Push to remote";
        }
        if (actualCommand.matches("^git\\s+pull\\b.*")) {
            return "Pull from remote";
        }
        if (actualCommand.matches("^git\\s+.*") && words.length > 1) {
            return "Run git " + words[1];
        }
        if (actualCommand.matches("^npm\\s+install\\b.*")) {
            return "Install npm packages";
        }
        if (actualCommand.matches("^npm\\s+run\\b.*")) {
            return "Run npm script";
        }
        if (actualCommand.matches("^npm\\s+.*") && words.length > 1) {
            return "Run npm " + words[1];
        }
        if (actualCommand.matches("^(yarn|pnpm)\\s+.*")) {
            return "Run " + firstWord + " command";
        }
        if (actualCommand.matches("^(gradle|mvn|make)\\b.*")) {
            return "Run " + firstWord + " build";
        }
        return actualCommand.length() <= 30 ? actualCommand : "Run " + firstWord;
    }

    private static String extractActualCommand(String command) {
        if (command == null) {
            return "";
        }
        String actualCommand = command.trim();
        Matcher shellWrapper = SHELL_WRAPPER_PATTERN.matcher(actualCommand);
        if (shellWrapper.matches()) {
            actualCommand = shellWrapper.group(1);
        }
        Matcher cdPrefix = CD_PREFIX_PATTERN.matcher(actualCommand);
        if (cdPrefix.matches()) {
            actualCommand = cdPrefix.group(1);
        }
        // PowerShell's call operator is an invocation marker, not the executable name.
        return actualCommand.trim().replaceFirst("^&\\s+", "");
    }

    private static String getStringProperty(JsonObject object, String propertyName) {
        if (object == null
                || !object.has(propertyName)
                || object.get(propertyName).isJsonNull()
                || !object.get(propertyName).isJsonPrimitive()) {
            return null;
        }
        return object.get(propertyName).getAsString();
    }

    static final class Output {
        private final JsonObject payload;
        private final String timestamp;

        Output(JsonObject payload, String timestamp) {
            this.payload = payload;
            this.timestamp = timestamp;
        }
    }

    static final class Command {
        private final String command;
        private final String description;
        private final String workdir;
        private final Long timeoutMs;
        private final String justification;

        Command(String command, String description, String workdir, Long timeoutMs, String justification) {
            this.command = command;
            this.description = description;
            this.workdir = workdir;
            this.timeoutMs = timeoutMs;
            this.justification = justification;
        }

        long retainedBytes() {
            return 3L * (this.command.length() + (this.description == null ? 0 : this.description.length())
                    + (this.workdir == null ? 0 : this.workdir.length())
                    + (this.justification == null ? 0 : this.justification.length()));
        }
    }

    private static final class ParsedString {
        private final String value;
        private final int nextIndex;

        private ParsedString(String value, int nextIndex) {
            this.value = value;
            this.nextIndex = nextIndex;
        }
    }
}
