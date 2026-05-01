package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.jetbrains.annotations.NotNull;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Collects candidate file paths from tool_use blocks so auto-commit can scope
 * merge/commit operations to files touched in the current turn.
 */
final class ToolTouchedFileExtractor {

    private static final Pattern APPLY_PATCH_FILE_PATTERN = Pattern.compile(
            "(?m)^\\*\\*\\*\\s+(?:Add|Update|Delete)\\s+File:\\s+(.+?)\\s*$"
    );
    private static final Pattern APPLY_PATCH_MOVE_TO_PATTERN = Pattern.compile(
            "(?m)^\\*\\*\\*\\s+Move\\s+to:\\s+(.+?)\\s*$"
    );

    private static final Pattern SHELL_REDIRECT_PATTERN = Pattern.compile(
            "(?i)(?:>|>>|1>|1>>|2>|2>>|\\|\\s*tee\\s+(?:-a\\s+)?)\\s*([\"']?[^\\s\"'|;]+[\"']?)"
    );

    private static final Set<String> PATH_HINT_KEYS = Set.of(
            "path",
            "file_path",
            "filePath",
            "target",
            "old_path",
            "new_path",
            "from",
            "to"
    );

    private ToolTouchedFileExtractor() {
    }

    static Set<String> extractFromMessage(@NotNull JsonObject messageJson) {
        Set<String> results = new LinkedHashSet<>();
        if (!messageJson.has("message") || !messageJson.get("message").isJsonObject()) {
            return results;
        }

        JsonObject message = messageJson.getAsJsonObject("message");
        if (!message.has("content") || !message.get("content").isJsonArray()) {
            return results;
        }

        JsonArray content = message.getAsJsonArray("content");
        for (JsonElement item : content) {
            if (!item.isJsonObject()) {
                continue;
            }
            JsonObject block = item.getAsJsonObject();
            String type = block.has("type") && !block.get("type").isJsonNull()
                    ? block.get("type").getAsString()
                    : null;
            if (!"tool_use".equals(type)) {
                continue;
            }

            String toolName = block.has("name") && !block.get("name").isJsonNull()
                    ? block.get("name").getAsString()
                    : "";

            JsonObject input = block.has("input") && block.get("input").isJsonObject()
                    ? block.getAsJsonObject("input")
                    : null;

            if (input != null) {
                collectPathsFromJson(input, results);

                if ("apply_patch".equals(toolName) && input.has("patch") && input.get("patch").isJsonPrimitive()) {
                    collectPathsFromPatch(input.get("patch").getAsString(), results);
                }

                if ("shell_command".equals(toolName) && input.has("command") && input.get("command").isJsonPrimitive()) {
                    collectPathsFromShellCommand(input.get("command").getAsString(), results);
                }
            }
        }

        return results;
    }

    private static void collectPathsFromJson(JsonElement value, Set<String> out) {
        if (value == null || value.isJsonNull()) {
            return;
        }
        if (value.isJsonObject()) {
            JsonObject obj = value.getAsJsonObject();
            for (String key : obj.keySet()) {
                JsonElement child = obj.get(key);
                if (PATH_HINT_KEYS.contains(key) && child != null && child.isJsonPrimitive()) {
                    addPath(out, child.getAsString());
                }
                if ("paths".equals(key) && child != null && child.isJsonArray()) {
                    for (JsonElement p : child.getAsJsonArray()) {
                        if (p != null && p.isJsonPrimitive()) {
                            addPath(out, p.getAsString());
                        }
                    }
                } else {
                    collectPathsFromJson(child, out);
                }
            }
            return;
        }
        if (value.isJsonArray()) {
            for (JsonElement child : value.getAsJsonArray()) {
                collectPathsFromJson(child, out);
            }
        }
    }

    private static void collectPathsFromPatch(String patch, Set<String> out) {
        Matcher matcher = APPLY_PATCH_FILE_PATTERN.matcher(patch);
        while (matcher.find()) {
            addPath(out, matcher.group(1));
        }
        Matcher moveMatcher = APPLY_PATCH_MOVE_TO_PATTERN.matcher(patch);
        while (moveMatcher.find()) {
            addPath(out, moveMatcher.group(1));
        }
    }

    private static void collectPathsFromShellCommand(String command, Set<String> out) {
        Matcher matcher = SHELL_REDIRECT_PATTERN.matcher(command);
        while (matcher.find()) {
            addPath(out, matcher.group(1));
        }
    }

    private static void addPath(Set<String> out, String rawPath) {
        if (rawPath == null) {
            return;
        }
        String p = rawPath.trim();
        if (p.isEmpty()) {
            return;
        }
        if ((p.startsWith("\"") && p.endsWith("\"")) || (p.startsWith("'") && p.endsWith("'"))) {
            p = p.substring(1, p.length() - 1).trim();
        }
        if (p.isEmpty() || "-".equals(p) || p.contains("\n") || p.contains("\r")) {
            return;
        }
        out.add(p);
    }
}
