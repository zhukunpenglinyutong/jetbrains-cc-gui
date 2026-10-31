package com.github.claudecodegui.handler.history;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Comparator;
import java.util.regex.Pattern;

/** Reads bounded literal expressions without evaluating historical JavaScript. */
final class CodexExecLiteralReader {
    static final String IDENTIFIER = "[A-Za-z_$][A-Za-z0-9_$]*";
    private static final Pattern DECLARATION = Pattern.compile("const\\s+(" + IDENTIFIER + ")\\s*=\\s*");
    private static final Pattern BRACKET_TOOL = Pattern.compile("(tools|functions)\\s*\\[\\s*(['\"])(" + IDENTIFIER + ")\\2\\s*]");
    private static final Pattern TOOL_ARGUMENT = Pattern.compile("(?:tools|functions)\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(");
    private static final Pattern TOOL_ALIAS = Pattern.compile("const\\s+(" + IDENTIFIER + ")\\s*=\\s*((?:tools|functions)\\.(" + IDENTIFIER + "))\\s*;");
    private static final Pattern DESTRUCTURED_TOOLS = Pattern.compile("const\\s*\\{([^{}]+)}\\s*=\\s*(tools|functions)\\s*;");

    private record Replacement(int start, int end, String text) { }

    private CodexExecLiteralReader() { }

    static String normalizeToolAccess(String source) {
        StringBuilder normalized = new StringBuilder(source);
        for (String namespace : List.of("tools", "functions")) {
            int cursor = 0;
            while ((cursor = CodexExecHistoryReplay.findJavaScriptToken(source, namespace, cursor)) >= 0) {
                var matcher = BRACKET_TOOL.matcher(source);
                matcher.region(cursor, source.length());
                if (matcher.lookingAt()) {
                    String replacement = namespace + "." + matcher.group(3);
                    normalized.replace(cursor, matcher.end(), replacement + " ".repeat(matcher.end() - cursor - replacement.length()));
                }
                // Start at a known code token so strings and comments keep their lexical context.
                cursor += namespace.length();
            }
        }
        return normalizeAliases(normalized.toString());
    }

    private static String normalizeAliases(String source) {
        List<Replacement> replacements = new ArrayList<>();
        var alias = TOOL_ALIAS.matcher(source);
        while (alias.find()) {
            if (CodexExecHistoryReplay.findJavaScriptToken(source, "const", alias.start()) == alias.start() && isTopLevel(source, alias.start())) {
                List<Replacement> calls = readAliasCalls(source, alias.group(1), alias.group(2), alias.start(), alias.end());
                if (calls != null) {
                    replacements.addAll(calls);
                    replacements.add(new Replacement(alias.start(), alias.end(), " ".repeat(alias.end() - alias.start())));
                }
            }
        }
        var destructured = DESTRUCTURED_TOOLS.matcher(source);
        while (destructured.find()) {
            if (CodexExecHistoryReplay.findJavaScriptToken(source, "const", destructured.start()) != destructured.start() || !isTopLevel(source, destructured.start())) {
                continue;
            }
            List<Replacement> calls = new ArrayList<>();
            boolean valid = true;
            for (String field : split(destructured.group(1), ',')) {
                List<String> pair = split(field, ':');
                if (pair.size() > 2 || !pair.get(0).matches(IDENTIFIER) || !pair.get(pair.size() - 1).matches(IDENTIFIER)) {
                    valid = false;
                    break;
                }
                List<Replacement> references = readAliasCalls(source, pair.get(pair.size() - 1), destructured.group(2) + "." + pair.get(0),
                        destructured.start(), destructured.end());
                if (references == null) {
                    valid = false;
                    break;
                }
                calls.addAll(references);
            }
            if (valid) {
                replacements.addAll(calls);
                replacements.add(new Replacement(destructured.start(), destructured.end(), " ".repeat(destructured.end() - destructured.start())));
            }
        }
        replacements.sort(Comparator.comparingInt(Replacement::start).reversed());
        StringBuilder result = new StringBuilder(source);
        int previous = source.length();
        for (Replacement replacement : replacements) {
            if (replacement.end > previous) {
                return source;
            }
            result.replace(replacement.start, replacement.end, replacement.text);
            previous = replacement.start;
        }
        return result.toString();
    }

    private static List<Replacement> readAliasCalls(String script, String name, String tool, int declarationStart, int start) {
        List<Replacement> calls = new ArrayList<>();
        if (CodexExecHistoryReplay.findJavaScriptToken(script, name, 0) < declarationStart) {
            // A hoisted function can invoke an alias from source preceding its declaration.
            return null;
        }
        int reference = start;
        while ((reference = CodexExecHistoryReplay.findJavaScriptToken(script, name, reference)) >= 0) {
            int next = CodexExecHistoryReplay.skipTrivia(script, reference + name.length(), script.length());
            if (next >= script.length() || script.charAt(next) != '(' || script.substring(0, reference).matches("(?s).*\\bfunction\\s*$")) {
                return null;
            }
            calls.add(new Replacement(reference, reference + name.length(), tool));
            reference += name.length();
        }
        return calls;
    }

    static JsonElement read(String source, Map<String, JsonElement> bindings) {
        return read(source.strip(), bindings, 0);
    }

    private static JsonElement read(String source, Map<String, JsonElement> bindings, int depth) {
        if (source.isEmpty() || depth > 24) {
            return null;
        }
        String normalized = CodexExecHistoryReplay.normalizeJavaScriptLiteralToJson(source);
        if (normalized != null) {
            try {
                return JsonParser.parseString(normalized);
            } catch (RuntimeException ignored) {
                return null;
            }
        }
        if (bindings.containsKey(source)) {
            return bindings.get(source).deepCopy();
        }
        if (source.startsWith("{") && source.endsWith("}")) {
            JsonObject object = new JsonObject();
            for (String field : split(source.substring(1, source.length() - 1), ',')) {
                if (field.isBlank()) {
                    continue;
                }
                if (field.startsWith("...")) {
                    JsonElement spread = read(field.substring(3).strip(), bindings, depth + 1);
                    if (spread == null || !spread.isJsonObject()) {
                        return null;
                    }
                    spread.getAsJsonObject().entrySet().forEach(entry -> object.add(entry.getKey(), entry.getValue().deepCopy()));
                    continue;
                }
                List<String> pair = split(field, ':');
                if (pair.size() > 2) {
                    return null;
                }
                String key = pair.get(0);
                if (!key.matches(IDENTIFIER)) {
                    JsonElement literalKey = read(key, Map.of(), depth + 1);
                    if (literalKey == null || !literalKey.isJsonPrimitive() || !literalKey.getAsJsonPrimitive().isString()) {
                        return null;
                    }
                    key = literalKey.getAsString();
                }
                if (key.equals("__proto__")) {
                    return null;
                }
                JsonElement value = read(pair.size() == 1 ? pair.get(0) : pair.get(1), bindings, depth + 1);
                if (value == null) {
                    return null;
                }
                object.add(key, value);
            }
            return object;
        }
        List<String> terms = split(source, '+');
        if (terms.size() > 1) {
            StringBuilder text = new StringBuilder();
            for (String term : terms) {
                JsonElement value = read(term, bindings, depth + 1);
                // Numeric arithmetic has different coercion rules; only concatenate known strings.
                if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
                    return null;
                }
                text.append(value.getAsString());
            }
            return new JsonPrimitive(text.toString());
        }
        return null;
    }

    static Map<String, JsonElement> readBindings(String script, int argumentStart, int argumentEnd) {
        Map<String, JsonElement> bindings = new LinkedHashMap<>();
        int cursor = 0;
        while ((cursor = CodexExecHistoryReplay.findJavaScriptToken(script, "const", cursor)) >= 0 && cursor < argumentStart) {
            var declaration = DECLARATION.matcher(script);
            declaration.region(cursor, argumentStart);
            if (!declaration.lookingAt() || !isTopLevel(script, cursor)) {
                cursor += 5;
                continue;
            }
            int start = declaration.end();
            int end = expressionEnd(script, start, argumentStart);
            if (end < start) {
                cursor += 5;
                continue;
            }
            String name = declaration.group(1);
            JsonElement value = read(script.substring(start, end), bindings);
            String references = script.replace("...", "   ");
            if (CodexExecHistoryReplay.findJavaScriptToken(references, name, 0) != declaration.start(1)) {
                cursor = end + 1;
                continue;
            }
            int reference = CodexExecHistoryReplay.findJavaScriptToken(references, name, end + 1);
            while (value != null && reference >= 0 && reference < argumentStart && readOnlyArgument(script, reference, name, value, bindings)) {
                reference = CodexExecHistoryReplay.findJavaScriptToken(references, name, reference + name.length());
            }
            int later = CodexExecHistoryReplay.findJavaScriptToken(references, name, argumentEnd);
            while (value != null && later >= 0 && readOnlyArgument(script, later, name, value, bindings)) {
                later = CodexExecHistoryReplay.findJavaScriptToken(references, name, later + name.length());
            }
            // Later declarations can be hoisted; every use must preserve this literal, regardless of source order.
            if (value != null && reference >= argumentStart && reference < argumentEnd && later < 0) {
                bindings.put(name, value);
            }
            cursor = end + 1;
        }
        return bindings;
    }

    private static boolean readOnlyArgument(String script, int reference, String name, JsonElement value, Map<String, JsonElement> known) {
        var tool = TOOL_ARGUMENT.matcher(script);
        while (tool.find() && tool.start() < reference) {
            if (tool.group(1).equals("apply_patch") || CodexExecHistoryReplay.findJavaScriptToken(script, tool.group().substring(0, tool.group().indexOf('(')).strip(), tool.start()) != tool.start()) {
                continue;
            }
            int paren = tool.end() - 1;
            int end = CodexExecHistoryReplay.findMatchingParenthesisEnd(script, paren);
            if (reference < end) {
                Map<String, JsonElement> bindings = new LinkedHashMap<>(known);
                bindings.put(name, value);
                return read(script.substring(paren + 1, end), bindings) != null;
            }
        }
        return false;
    }

    static List<String> split(String source, char delimiter) {
        if (CodexExecHistoryReplay.containsUnparsedExpression(source)) {
            // Regex delimiters and division require a JavaScript parser, not bracket counting.
            return List.of(source);
        }
        List<String> parts = new ArrayList<>();
        int start = 0;
        int depth = 0;
        for (int index = 0; index < source.length(); index++) {
            char value = source.charAt(index);
            if (value == '\'' || value == '"' || value == '`') {
                index = CodexExecHistoryReplay.skipJavaScriptString(source, index) - 1;
            } else if (value == '/' && index + 1 < source.length() && (source.charAt(index + 1) == '/' || source.charAt(index + 1) == '*')) {
                index = CodexExecHistoryReplay.skipTrivia(source, index, source.length()) - 1;
            } else if (value == '(' || value == '[' || value == '{') {
                depth++;
            } else if (value == ')' || value == ']' || value == '}') {
                depth--;
            } else if (value == delimiter && depth == 0) {
                parts.add(source.substring(start, index).strip());
                start = index + 1;
            }
        }
        parts.add(source.substring(start).strip());
        return parts;
    }

    static boolean isTopLevel(String script, int end) {
        List<String> parts = split(script.substring(0, end) + ";", ';');
        return parts.get(parts.size() - 1).isEmpty();
    }

    static boolean reachesCallInSourceOrder(String script, int position) {
        List<Integer> arrows = new ArrayList<>();
        int depth = 0;
        int braces = 0;
        for (int cursor = 0; cursor < position; cursor++) {
            char value = script.charAt(cursor);
            if (value == '\'' || value == '"' || value == '`') {
                int end = CodexExecHistoryReplay.skipJavaScriptString(script, cursor);
                if (end > position) {
                    return false;
                }
                cursor = end - 1;
            } else if (value == '/') {
                int end = CodexExecHistoryReplay.skipTrivia(script, cursor, script.length());
                if (end <= cursor || end > position) {
                    return false;
                }
                cursor = end - 1;
            } else if (value == '=' && cursor + 1 < position && script.charAt(cursor + 1) == '>') {
                int body = CodexExecHistoryReplay.skipTrivia(script, cursor + 2, script.length());
                if (body < script.length() && script.charAt(body) == '{') {
                    int end = CodexExecHistoryReplay.findMatchingObjectEnd(script, body);
                    if (end < body || end >= position) {
                        return false;
                    }
                    cursor = end;
                } else {
                    arrows.add(depth);
                    cursor++;
                }
            } else if (value == '(' || value == '[' || value == '{') {
                depth++;
                if (value == '{') {
                    braces++;
                }
            } else if (value == ')' || value == ']' || value == '}') {
                int scope = depth;
                arrows.removeIf(arrow -> arrow >= scope);
                depth--;
                if (value == '}') {
                    braces--;
                }
            } else if (value == ',' || value == ';') {
                int scope = depth;
                arrows.removeIf(arrow -> arrow >= scope);
            }
        }
        // Deferred callbacks and conditional blocks need their own execution evidence, not lexical ordering.
        return arrows.isEmpty() && braces == 0;
    }

    private static int expressionEnd(String script, int start, int limit) {
        List<String> parts = split(script.substring(start, limit), ';');
        if (parts.size() < 2) {
            return -1;
        }
        // split strips whitespace; locate the actual delimiter without changing source coordinates.
        int end = start;
        int depth = 0;
        while (end < limit) {
            char value = script.charAt(end);
            if (value == '\'' || value == '"' || value == '`') {
                end = CodexExecHistoryReplay.skipJavaScriptString(script, end);
                continue;
            }
            if (value == '(' || value == '[' || value == '{') {
                depth++;
            } else if (value == ')' || value == ']' || value == '}') {
                depth--;
            } else if (value == ';' && depth == 0) {
                return end;
            }
            end++;
        }
        return -1;
    }
}
