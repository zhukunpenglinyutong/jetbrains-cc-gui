package com.github.claudecodegui.hooks;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.github.claudecodegui.util.PlatformUtils;
import org.tomlj.Toml;
import org.tomlj.TomlParseResult;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Codex 0.163 declarations and per-handler user state; never executes hooks. */
final class CodexHookToml {
    private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    private static final Set<String> EVENTS = Set.of("PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact",
            "SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop", "Interrupt");
    private static final Pattern ENABLED_LINE = Pattern.compile("^(\\s*(?:enabled|\"enabled\"|'enabled')\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$");
    private CodexHookToml() { }

    static ParseResult parse(String content, Path source, String userConfig) {
        TomlParseResult parsed = Toml.parse(content);
        TomlParseResult user = Toml.parse(userConfig);
        if (parsed.hasErrors() || user.hasErrors()) {
            return invalid("INVALID_TOML");
        }
        JsonObject root = JsonParser.parseString(parsed.toJson()).getAsJsonObject();
        JsonObject preferences = JsonParser.parseString(user.toJson()).getAsJsonObject();
        return collect(root.get("hooks"), source, preferences, featureEnabled(root, featureEnabled(preferences, true)));
    }

    static ParseResult parseJson(String content, Path source, String userConfig) {
        TomlParseResult user = Toml.parse(userConfig);
        if (user.hasErrors()) {
            return invalid("INVALID_TOML");
        }
        try {
            JsonObject root = JsonParser.parseString(content).getAsJsonObject();
            if (!Set.of("description", "hooks").containsAll(root.keySet())) {
                return invalid("CODEX_HOOK_FILE_FIELDS_INVALID");
            }
            JsonObject preferences = JsonParser.parseString(user.toJson()).getAsJsonObject();
            return collect(root.get("hooks"), source, preferences, featureEnabled(preferences, true));
        } catch (RuntimeException error) {
            return invalid("INVALID_JSON");
        }
    }

    private static boolean featureEnabled(JsonObject root, boolean fallback) {
        JsonObject features = object(root.get("features"));
        if (features == null) {
            return fallback;
        }
        Boolean current = bool(features.get("hooks"));
        Boolean legacy = bool(features.get("codex_hooks"));
        return current != null ? current : legacy != null ? legacy : fallback;
    }

    private static ParseResult collect(JsonElement value, Path source, JsonObject preferences, boolean featureEnabled) {
        if (value == null) {
            return new ParseResult(true, featureEnabled, List.of(), List.of());
        }
        JsonObject hooks = object(value);
        if (hooks == null) {
            return invalid("CODEX_HOOKS_NOT_TABLE");
        }
        JsonObject preferenceHooks = object(preferences.get("hooks"));
        JsonObject state = preferenceHooks == null ? null : object(preferenceHooks.get("state"));
        List<Entry> entries = new ArrayList<>();
        List<String> issues = new ArrayList<>();
        for (String event : hooks.keySet()) {
            if ("state".equals(event)) {
                continue;
            }
            if (!EVENTS.contains(event)) {
                issues.add("CODEX_EVENT_UNSUPPORTED");
                continue;
            }
            JsonElement groups = hooks.get(event);
            if (!groups.isJsonArray()) {
                issues.add("CODEX_HOOK_EVENT_NOT_ARRAY");
                continue;
            }
            JsonArray groupArray = groups.getAsJsonArray();
            for (int groupIndex = 0; groupIndex < groupArray.size(); groupIndex++) {
                JsonObject group = object(groupArray.get(groupIndex));
                if (group == null || !group.has("hooks") || !group.get("hooks").isJsonArray()) {
                    issues.add("CODEX_COMMANDS_INVALID");
                    continue;
                }
                JsonArray handlers = group.getAsJsonArray("hooks");
                String matcher = string(group.get("matcher"));
                for (int handlerIndex = 0; handlerIndex < handlers.size(); handlerIndex++) {
                    JsonObject handler = object(handlers.get(handlerIndex));
                    List<String> handlerIssues = new ArrayList<>();
                    String type = handler == null ? null : string(handler.get("type"));
                    String command = handler == null ? null : string(handler.get("command"));
                    if (handler != null && PlatformUtils.isWindows() && string(handler.get("commandWindows")) != null) {
                        command = string(handler.get("commandWindows"));
                    }
                    if ("mcp_tool".equals(type) && string(handler.get("server")) != null && string(handler.get("tool")) != null) {
                        command = string(handler.get("server")) + "/" + string(handler.get("tool"));
                    } else if (!"command".equals(type) || command == null || command.isBlank()) {
                        handlerIssues.add("CODEX_HANDLER_UNSUPPORTED");
                    }
                    if (group.has("matcher") && !group.get("matcher").isJsonNull() && matcher == null) {
                        handlerIssues.add("CODEX_MATCHER_INVALID");
                    }
                    String key = stateKey(source, event, groupIndex, handlerIndex);
                    JsonObject override = state == null ? null : object(state.get(key));
                    Boolean enabled = override == null ? null : bool(override.get("enabled"));
                    if (override != null && override.has("enabled") && enabled == null) {
                        handlerIssues.add("CODEX_ENABLED_INVALID");
                    }
                    entries.add(new Entry(event, key, enabled == null || enabled, matcher, command == null ? "" : command,
                            GSON.toJson(handler), Set.copyOf(handlerIssues)));
                }
            }
        }
        return new ParseResult(true, featureEnabled, List.copyOf(entries), List.copyOf(issues));
    }

    static String stateKey(Path source, String event, int group, int handler) {
        String label = event.replaceAll("([a-z])([A-Z])", "$1_$2").toLowerCase(java.util.Locale.ROOT);
        Path nativeSource = source.toAbsolutePath().normalize();
        try {
            // The native CLI canonicalizes config layers, including a linked CODEX_HOME.
            nativeSource = nativeSource.toRealPath();
        } catch (java.io.IOException ignored) {
            // Parsing previews for absent files still has a deterministic identity.
        }
        return nativeSource + ":" + label + ":" + group + ":" + handler;
    }

    static UpdateResult updateEnabled(String content, String key, boolean enabled) {
        TomlParseResult parsed = Toml.parse(content);
        if (parsed.hasErrors() || key == null || key.isBlank()) {
            return new UpdateResult(null, "INVALID_TOML");
        }
        List<String> field = List.of("hooks", "state", key, "enabled");
        if (parsed.contains(field)) {
            if (!parsed.isBoolean(field)) {
                return new UpdateResult(null, "CODEX_ENABLED_INVALID");
            }
            String updated = replaceEnabledLine(content, parsed.inputPositionOf(field).line(), enabled);
            return new UpdateResult(updated, updated == null ? "CODEX_STATE_INLINE_UNSUPPORTED" : null);
        }
        String table = "[hooks.state." + GSON.toJson(key) + "]";
        String newline = content.contains("\r\n") ? "\r\n" : "\n";
        Matcher header = Pattern.compile("(?m)^" + Pattern.quote(table) + "[ \\t]*(?:#.*)?\\r?$").matcher(content);
        if (header.find()) {
            int end = content.indexOf('\n', header.end());
            if (end < 0) {
                return new UpdateResult(content + newline + "enabled = " + enabled + newline, null);
            }
            return new UpdateResult(content.substring(0, end + 1) + "enabled = " + enabled + newline + content.substring(end + 1), null);
        }
        String result = content + (content.isEmpty() || content.endsWith("\n") ? "" : newline)
                + newline + table + newline + "enabled = " + enabled + newline;
        return Toml.parse(result).hasErrors() ? new UpdateResult(null, "CODEX_STATE_INLINE_UNSUPPORTED") : new UpdateResult(result, null);
    }

    private static String replaceEnabledLine(String content, int lineNumber, boolean enabled) {
        int start = 0;
        for (int line = 1; line < lineNumber; line++) {
            int next = content.indexOf('\n', start);
            if (next < 0) {
                return null;
            }
            start = next + 1;
        }
        int end = content.indexOf('\n', start);
        if (end < 0) {
            end = content.length();
        }
        int valueEnd = end > start && content.charAt(end - 1) == '\r' ? end - 1 : end;
        Matcher matcher = ENABLED_LINE.matcher(content.substring(start, valueEnd));
        return matcher.matches() ? content.substring(0, start) + matcher.group(1) + enabled + matcher.group(2) + content.substring(valueEnd) : null;
    }

    private static JsonObject object(JsonElement value) { return value != null && value.isJsonObject() ? value.getAsJsonObject() : null; }
    private static String string(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : null;
    }
    private static Boolean bool(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isBoolean() ? value.getAsBoolean() : null;
    }
    private static ParseResult invalid(String issue) { return new ParseResult(false, false, List.of(), List.of(issue)); }
    record Entry(String event, String managedKey, Boolean enabled, String matcher, String command, String rawPreview, Set<String> validationIssues) { }
    record ParseResult(boolean valid, boolean featureEnabled, List<Entry> entries, List<String> sourceIssues) { }
    record UpdateResult(String content, String errorCode) { boolean success() { return errorCode == null; } }
}
