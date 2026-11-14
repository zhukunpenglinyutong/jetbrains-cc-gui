package com.github.claudecodegui.hooks;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonWriter;

import java.io.IOException;
import java.io.StringWriter;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Replaces only the root hooks value, leaving unrelated settings bytes intact. */
final class HookJsonSource {

    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    private static final Pattern INDENT = Pattern.compile("(?:^|\\n)([ \\t]+)\"");

    private HookJsonSource() {
    }

    static String replaceHooks(String source, JsonObject hooks) throws IOException {
        int cursor = whitespace(source, 0);
        if (cursor >= source.length() || source.charAt(cursor++) != '{') {
            throw new IOException("Settings must be an object");
        }
        int valueStart = -1;
        int valueEnd = -1;
        boolean hasMembers = false;
        while (true) {
            cursor = whitespace(source, cursor);
            if (source.charAt(cursor) == '}') {
                break;
            }
            hasMembers = true;
            int keyEnd = stringEnd(source, cursor);
            String key = JsonParser.parseString(source.substring(cursor, keyEnd)).getAsString();
            cursor = whitespace(source, keyEnd);
            if (source.charAt(cursor++) != ':') {
                throw new IOException("Invalid settings member");
            }
            cursor = whitespace(source, cursor);
            int end = valueEnd(source, cursor);
            if ("hooks".equals(key)) {
                if (valueStart >= 0) {
                    throw new IOException("Duplicate hooks members are ambiguous");
                }
                valueStart = cursor;
                valueEnd = end;
            }
            cursor = whitespace(source, end);
            if (source.charAt(cursor) == ',') {
                cursor++;
            } else if (source.charAt(cursor) != '}') {
                throw new IOException("Invalid settings object");
            }
        }
        Matcher indentation = INDENT.matcher(source);
        String indent = indentation.find() ? indentation.group(1) : "";
        String newline = source.contains("\r\n") ? "\r\n" : "\n";
        StringWriter buffer = new StringWriter();
        JsonWriter writer = GSON.newJsonWriter(buffer);
        writer.setIndent(indent);
        GSON.toJson(hooks, writer);
        String replacement = buffer.toString().replace("\n", newline + indent);
        if (valueStart >= 0) {
            return source.substring(0, valueStart) + replacement + source.substring(valueEnd);
        }
        // Recovery can restore a disabled hook after the hooks member was removed externally.
        int insertion = cursor;
        while (insertion > 0 && Character.isWhitespace(source.charAt(insertion - 1))) {
            insertion--;
        }
        String prefix = (hasMembers ? "," : "") + (indent.isEmpty() ? "" : newline + indent);
        return source.substring(0, insertion) + prefix + "\"hooks\":" + (indent.isEmpty() ? "" : " ")
                + replacement + source.substring(insertion);
    }

    private static int whitespace(String text, int offset) {
        while (offset < text.length() && Character.isWhitespace(text.charAt(offset))) {
            offset++;
        }
        return offset;
    }

    private static int stringEnd(String text, int start) throws IOException {
        if (text.charAt(start) != '"') {
            throw new IOException("Expected a JSON string");
        }
        for (int i = start + 1; i < text.length(); i++) {
            if (text.charAt(i) == '\\') {
                i++;
            } else if (text.charAt(i) == '"') {
                return i + 1;
            }
        }
        throw new IOException("Unterminated JSON string");
    }

    private static int valueEnd(String text, int start) throws IOException {
        if (text.charAt(start) == '"') {
            return stringEnd(text, start);
        }
        int depth = 0;
        for (int i = start; i < text.length(); i++) {
            char current = text.charAt(i);
            if (current == '"') {
                i = stringEnd(text, i) - 1;
            } else if (current == '{' || current == '[') {
                depth++;
            } else if (current == '}' || current == ']') {
                if (depth == 0) {
                    return trimmedEnd(text, start, i);
                }
                if (--depth == 0) {
                    return i + 1;
                }
            } else if (current == ',' && depth == 0) {
                return trimmedEnd(text, start, i);
            }
        }
        throw new IOException("Unterminated JSON value");
    }

    private static int trimmedEnd(String text, int start, int end) {
        while (end > start && Character.isWhitespace(text.charAt(end - 1))) {
            end--;
        }
        return end;
    }
}
