package com.github.claudecodegui.hooks;

import org.tomlj.Toml;
import org.tomlj.TomlArray;
import org.tomlj.TomlParseResult;
import org.tomlj.TomlPosition;
import org.tomlj.TomlTable;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Parses and minimally updates Codex hooks stored in config.toml. */
final class CodexHookToml {

    private static final Pattern ENABLED_LINE = Pattern.compile(
            "^(\\s*(?:enabled|\\\"enabled\\\"|'enabled')\\s*=\\s*)(?:true|false)(\\s*(?:#.*)?)$"
    );

    private CodexHookToml() {
    }

    static ParseResult parse(String content) {
        TomlParseResult parsed = Toml.parse(content == null ? "" : content);
        if (parsed.hasErrors()) {
            return new ParseResult(false, false, List.of(), List.of("INVALID_TOML"));
        }
        boolean featureEnabled = parsed.isTable("features")
                && parsed.getTable("features").isBoolean("hooks")
                && parsed.getTable("features").getBoolean("hooks");
        Object hooksValue = parsed.get("hooks");
        if (hooksValue == null) {
            return new ParseResult(true, featureEnabled, List.of(), List.of());
        }
        if (!(hooksValue instanceof TomlTable hooksTable)) {
            return new ParseResult(false, featureEnabled, List.of(), List.of("CODEX_HOOKS_NOT_TABLE"));
        }

        List<Entry> entries = new ArrayList<>();
        List<String> sourceIssues = new ArrayList<>();
        for (String event : hooksTable.keySet()) {
            Object eventValue = hooksTable.get(event);
            if (!(eventValue instanceof TomlArray eventHooks) || !containsOnlyTables(eventHooks)) {
                addIssue(sourceIssues, "CODEX_HOOK_EVENT_NOT_ARRAY");
                continue;
            }
            for (int index = 0; index < eventHooks.size(); index++) {
                Object value = eventHooks.get(index);
                if (!(value instanceof TomlTable hook)) {
                    addIssue(sourceIssues, "CODEX_HOOK_ENTRY_NOT_TABLE");
                    continue;
                }
                List<String> issues = new ArrayList<>();
                Boolean enabled = hook.isBoolean("enabled") ? hook.getBoolean("enabled") : null;
                if (enabled == null) {
                    issues.add("CODEX_ENABLED_INVALID");
                }
                String matcher = null;
                if (hook.contains("matcher")) {
                    if (hook.isString("matcher")) {
                        matcher = hook.getString("matcher");
                    } else {
                        issues.add("CODEX_MATCHER_INVALID");
                    }
                }
                TomlArray commands = hook.isArray("hooks") ? hook.getArray("hooks") : null;
                if (commands == null || !containsOnlyTables(commands) || commands.isEmpty()) {
                    issues.add("CODEX_COMMANDS_INVALID");
                }
                TomlPosition enabledPosition = hook.inputPositionOf("enabled");
                entries.add(new Entry(
                        event,
                        index,
                        event + "/" + index,
                        enabled,
                        matcher,
                        commandPreview(commands),
                        hook.toJson(),
                        enabledPosition == null ? -1 : enabledPosition.line(),
                        Set.copyOf(issues)
                ));
            }
        }
        return new ParseResult(true, featureEnabled, List.copyOf(entries), List.copyOf(sourceIssues));
    }

    static UpdateResult updateEnabled(String content, String managedKey, boolean enabled) {
        ParseResult parsed = parse(content);
        if (!parsed.valid()) {
            return new UpdateResult(null, "INVALID_TOML");
        }
        Entry target = null;
        for (Entry entry : parsed.entries()) {
            if (entry.managedKey().equals(managedKey)) {
                if (target != null) {
                    return new UpdateResult(null, "HOOK_IDENTITY_AMBIGUOUS");
                }
                target = entry;
            }
        }
        if (target == null) {
            return new UpdateResult(null, "HOOK_NOT_FOUND");
        }
        if (target.enabled() == null || target.enabledLine() < 1) {
            return new UpdateResult(null, "CODEX_ENABLED_INVALID");
        }
        String updated = replaceEnabledLine(content, target.enabledLine(), enabled);
        return updated == null
                ? new UpdateResult(null, "CODEX_ENABLED_INVALID")
                : new UpdateResult(updated, null);
    }

    private static String commandPreview(TomlArray commands) {
        if (commands == null || commands.isEmpty() || !(commands.get(0) instanceof TomlTable command)) {
            return "";
        }
        String executable = command.isString("command") ? command.getString("command") : "";
        TomlArray args = command.isArray("args") ? command.getArray("args") : null;
        if (args == null || !containsOnlyStrings(args)) {
            return executable;
        }
        StringBuilder preview = new StringBuilder(executable);
        for (int i = 0; i < args.size(); i++) {
            if (!preview.isEmpty()) {
                preview.append(' ');
            }
            preview.append(args.getString(i));
        }
        return preview.toString();
    }

    private static boolean containsOnlyTables(TomlArray array) {
        for (int i = 0; i < array.size(); i++) {
            if (!(array.get(i) instanceof TomlTable)) {
                return false;
            }
        }
        return true;
    }

    private static boolean containsOnlyStrings(TomlArray array) {
        for (int i = 0; i < array.size(); i++) {
            if (!(array.get(i) instanceof String)) {
                return false;
            }
        }
        return true;
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
        int lineBreak = content.indexOf('\n', start);
        int end = lineBreak < 0 ? content.length() : lineBreak;
        int contentEnd = end > start && content.charAt(end - 1) == '\r' ? end - 1 : end;
        Matcher matcher = ENABLED_LINE.matcher(content.substring(start, contentEnd));
        if (!matcher.matches()) {
            return null;
        }
        String replacement = matcher.group(1) + enabled + matcher.group(2);
        return content.substring(0, start) + replacement + content.substring(contentEnd);
    }

    private static void addIssue(List<String> issues, String issue) {
        if (!issues.contains(issue)) {
            issues.add(issue);
        }
    }

    record Entry(
            String event,
            int index,
            String managedKey,
            Boolean enabled,
            String matcher,
            String command,
            String rawPreview,
            int enabledLine,
            Set<String> validationIssues
    ) {
    }

    record ParseResult(boolean valid, boolean featureEnabled, List<Entry> entries, List<String> sourceIssues) {
    }

    record UpdateResult(String content, String errorCode) {
        boolean success() {
            return errorCode == null;
        }
    }
}
