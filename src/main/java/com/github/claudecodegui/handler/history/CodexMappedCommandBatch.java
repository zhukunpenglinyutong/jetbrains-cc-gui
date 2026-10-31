package com.github.claudecodegui.handler.history;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/** Unpacks finite literal jobs while preserving the map or sequential loop's ordering. */
final class CodexMappedCommandBatch {
    private static final String IDENTIFIER = CodexExecLiteralReader.IDENTIFIER;
    private static final Pattern MAPPING = Pattern.compile("(?<![A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*+)\\s*\\.\\s*map\\s*\\(");
    private static final Pattern PROMISE = Pattern.compile("(?:await\\s+Promise\\.all(?:Settled)?|as_settled|stream_settled)\\s*\\(\\s*$");
    private static final Pattern LOOP = Pattern.compile("for\\s*\\(\\s*const\\s+(\\[[^\\]]+]|" + IDENTIFIER
            + ")\\s+of\\s+(" + IDENTIFIER + ")\\s*\\)\\s*(\\{\\s*)?(?:text\\s*\\(\\s*)?await\\s*$");
    private static final Pattern NEXT_STATEMENT = Pattern.compile("(?!(?:in|instanceof)\\b)" + IDENTIFIER);
    private static final int MAX_COMMANDS = 100;

    record Batch(List<JsonObject> inputs, boolean parallel) { }

    private CodexMappedCommandBatch() { }

    static Batch readInputs(String script, String token, int position) {
        var mapping = MAPPING.matcher(script.substring(0, position));
        int mappingStart = -1;
        int paren = -1;
        String name = null;
        while (mapping.find()) {
            mappingStart = mapping.start();
            paren = mapping.end() - 1;
            name = mapping.group(1);
        }
        if (mappingStart >= 0 && PROMISE.matcher(script.substring(0, mappingStart)).find()) {
            int mapEnd = CodexExecHistoryReplay.findMatchingParenthesisEnd(script, paren);
            int cursor = CodexExecHistoryReplay.skipTrivia(script, paren + 1, position);
            if (script.startsWith("async", cursor)) {
                int parameterStart = CodexExecHistoryReplay.skipTrivia(script, cursor + 5, position);
                // async may itself name a parameter, or begin a longer identifier.
                if (parameterStart < position && (script.charAt(parameterStart) == '('
                        || parameterStart > cursor + 5 && Character.isJavaIdentifierStart(script.charAt(parameterStart)))) {
                    cursor = parameterStart;
                }
            }
            String parameter;
            if (cursor < position && script.charAt(cursor) == '(') {
                int end = CodexExecHistoryReplay.findMatchingParenthesisEnd(script, cursor);
                if (end < cursor || end >= position) {
                    return null;
                }
                parameter = script.substring(cursor + 1, end).strip();
                cursor = CodexExecHistoryReplay.skipTrivia(script, end + 1, position);
            } else {
                int end = cursor;
                while (end < position && Character.isJavaIdentifierPart(script.charAt(end))) {
                    end++;
                }
                parameter = script.substring(cursor, end);
                cursor = CodexExecHistoryReplay.skipTrivia(script, end, position);
            }
            if (!script.startsWith("=>", cursor) || mapEnd < position) {
                return null;
            }
            String prefix = script.substring(cursor + 2, position).strip();
            String suffix = suffix(script, token, position, mapEnd);
            boolean plain = List.of("", "await").contains(prefix) && ")".equals(suffix);
            boolean block = prefix.matches("\\{\\s*return(?:\\s+await)?") && suffix != null && suffix.matches(";?\\s*}\\s*\\)");
            boolean labelled = prefix.matches("\\(\\s*\\{\\s*" + IDENTIFIER + "\\s*,\\s*\\.\\.\\.\\s*await")
                    && suffix != null && suffix.matches("}\\s*\\)\\s*\\)");
            if ((plain || block || labelled) && CodexExecLiteralReader.reachesCallInSourceOrder(script, mappingStart)) {
                return unpack(script, token, position, name, mappingStart, parameter, true);
            }
        }
        var loop = LOOP.matcher(script.substring(0, position));
        if (!loop.find() || !CodexExecLiteralReader.reachesCallInSourceOrder(script, loop.start())) {
            return null;
        }
        int callEnd = callEnd(script, token, position);
        if (callEnd < position) {
            return null;
        }
        int tail = CodexExecHistoryReplay.skipTrivia(script, callEnd + 1, script.length());
        String prefix = script.substring(loop.start(), position);
        if (prefix.matches("(?s).*\\btext\\s*\\(\\s*await\\s*$")) {
            if (tail >= script.length() || script.charAt(tail) != ')') {
                return null;
            }
            tail = CodexExecHistoryReplay.skipTrivia(script, tail + 1, script.length());
        }
        if (loop.group(3) == null && tail < script.length() && script.charAt(tail) != ';' && script.charAt(tail) != '}') {
            // A comma or another expression belongs to the same loop body and can change later jobs.
            return null;
        }
        if (tail < script.length() && script.charAt(tail) == ';') {
            tail = CodexExecHistoryReplay.skipTrivia(script, tail + 1, script.length());
        }
        if (loop.group(3) != null && (tail >= script.length() || script.charAt(tail) != '}')) {
            return null;
        }
        return unpack(script, token, position, loop.group(2), loop.start(2), loop.group(1), false);
    }

    private static String suffix(String script, String token, int position, int end) {
        int callEnd = callEnd(script, token, position);
        return callEnd < position || callEnd >= end ? null : script.substring(callEnd + 1, end + 1).strip();
    }

    private static int callEnd(String script, String token, int position) {
        int start = CodexExecHistoryReplay.skipTrivia(script, position + token.length(), script.length());
        return start >= script.length() || script.charAt(start) != '(' ? -1 : CodexExecHistoryReplay.findMatchingParenthesisEnd(script, start);
    }

    private static Batch unpack(String script, String token, int position, String batch, int reference, String parameter, boolean parallel) {
        var declaration = Pattern.compile("\\bconst\\s+(" + Pattern.quote(batch) + ")\\s*=\\s*(\\[)").matcher(script);
        declaration.region(0, reference);
        if (!declaration.find() || CodexExecHistoryReplay.findJavaScriptToken(script, "const", declaration.start()) != declaration.start()
                || !CodexExecLiteralReader.isTopLevel(script, declaration.start())) {
            return null;
        }
        int start = declaration.start(2);
        int end = CodexExecHistoryReplay.findMatchingArrayEnd(script, start);
        String references = script.replace("...", "   ");
        // Earlier closures can change jobs, and a literal prefix does not prove the initializer's value.
        if (end < start || end >= reference || !endsInitializer(script, end)
                || CodexExecHistoryReplay.findJavaScriptToken(references, batch, 0) != declaration.start(1)
                || CodexExecHistoryReplay.findJavaScriptToken(references, batch, end + 1) != reference
                || CodexExecHistoryReplay.findJavaScriptToken(references, batch, reference + batch.length()) >= 0) {
            return null;
        }
        JsonElement jobs = CodexExecLiteralReader.read(script.substring(start, end + 1), Map.of());
        if (jobs == null || !jobs.isJsonArray() || jobs.getAsJsonArray().isEmpty() || jobs.getAsJsonArray().size() > MAX_COMMANDS) {
            return null;
        }
        int argumentStart = CodexExecHistoryReplay.skipTrivia(script, position + token.length(), script.length()) + 1;
        int argumentEnd = callEnd(script, token, position);
        if (argumentEnd < argumentStart) {
            return null;
        }
        List<JsonObject> inputs = new ArrayList<>();
        Map<String, JsonElement> globals = CodexExecLiteralReader.readBindings(script, argumentStart, argumentEnd);
        for (JsonElement job : jobs.getAsJsonArray()) {
            Map<String, JsonElement> bindings = bind(parameter, job);
            if (bindings != null) {
                Map<String, JsonElement> arguments = new LinkedHashMap<>(globals);
                arguments.putAll(bindings);
                bindings = arguments;
            }
            JsonElement input = bindings == null ? null : CodexExecLiteralReader.read(script.substring(argumentStart, argumentEnd), bindings);
            if (input == null || !input.isJsonObject()) {
                return null;
            }
            inputs.add(input.getAsJsonObject());
        }
        return new Batch(inputs, parallel);
    }

    private static boolean endsInitializer(String script, int end) {
        int next = CodexExecHistoryReplay.skipTrivia(script, end + 1, script.length());
        if (next == script.length() || script.charAt(next) == ';') {
            return true;
        }
        // Preserve semicolon-free statements without accepting a chained transform across a newline.
        String gap = script.substring(end + 1, next);
        return (gap.indexOf('\n') >= 0 || gap.indexOf('\r') >= 0) && NEXT_STATEMENT.matcher(script).region(next, script.length()).lookingAt();
    }

    private static Map<String, JsonElement> bind(String parameter, JsonElement job) {
        Map<String, JsonElement> bindings = new LinkedHashMap<>();
        if (parameter.matches(IDENTIFIER)) {
            bindings.put(parameter, job);
            return bindings;
        }
        if (!parameter.startsWith("[") || !parameter.endsWith("]") || !job.isJsonArray()) {
            return null;
        }
        List<String> names = CodexExecLiteralReader.split(parameter.substring(1, parameter.length() - 1), ',');
        if (names.size() > job.getAsJsonArray().size()) {
            return null;
        }
        for (int index = 0; index < names.size(); index++) {
            String name = names.get(index);
            if (name.isEmpty()) {
                continue;
            }
            if (!name.matches(IDENTIFIER) || bindings.putIfAbsent(name, job.getAsJsonArray().get(index)) != null) {
                return null;
            }
        }
        return bindings;
    }
}
