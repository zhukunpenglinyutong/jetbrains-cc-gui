package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** A validated baseline; null content means that no file existed before the edits. */
public record FileChangeUndoPlan(String filePath, String content) {
    private static final Pattern HUNK = Pattern.compile("^@@ -(\\d+)(?:,(\\d+))? \\+(\\d+)(?:,(\\d+))? @@.*");

    /** Reverses recorded operations without changing any files. */
    public static FileChangeUndoPlan rebuild(String filePath, String content, JsonArray operations) {
        if (operations == null || operations.isEmpty()) {
            throw new IllegalArgumentException("No operations to undo");
        }
        String path = filePath;
        String before = content;
        for (int index = operations.size() - 1; index >= 0; index--) {
            JsonObject op = operations.get(index).getAsJsonObject();
            String kind = string(op, "fileChangeKind");
            String oldText = string(op, "oldString");
            String newText = string(op, "newString");
            if ("add".equals(kind)) {
                require(before != null && normalize(before).equals(normalize(newText)), "Added file has changed since the recorded edit");
                before = null;
            } else if ("delete".equals(kind)) {
                require(!op.has("oldStringKnown") || op.get("oldStringKnown").isJsonNull() || op.get("oldStringKnown").getAsBoolean(),
                        "The transcript did not record the deleted file content");
                require(before == null, "Deleted file has been recreated since the recorded edit");
                before = oldText;
            } else {
                require(before != null, "Modified file no longer exists");
                String patch = string(op, "patch");
                if (!patch.isEmpty()) {
                    before = reverseHunk(before, patch);
                } else if (!oldText.equals(newText)) {
                    require(!newText.isEmpty(), "Deletion cannot be restored without its patch location");
                    int position = before.indexOf(newText);
                    require(position >= 0, "Current file no longer matches the recorded edit");
                    if (op.has("replaceAll") && !op.get("replaceAll").isJsonNull() && op.get("replaceAll").getAsBoolean()) {
                        before = before.replace(newText, oldText);
                    } else {
                        // Same ambiguity bar as reverseHunk: without a patch there is
                        // no recorded location, so multiple matches would rewrite an
                        // arbitrary occurrence and silently corrupt the file.
                        require(before.indexOf(newText, position + 1) < 0,
                                "Recorded edit matches multiple locations in the current file");
                        before = before.substring(0, position) + oldText + before.substring(position + newText.length());
                    }
                }
            }
            String moveFrom = string(op, "moveFrom");
            if (!moveFrom.isEmpty()) {
                path = moveFrom;
            }
        }
        return new FileChangeUndoPlan(path, before);
    }

    private static String reverseHunk(String content, String patch) {
        String[] patchLines = normalize(patch).split("\n", -1);
        require(patchLines.length > 0 && patchLines[0].startsWith("@@"), "Invalid patch hunk");
        List<String> expected = new ArrayList<>();
        List<String> restored = new ArrayList<>();
        boolean oldNoNewline = false;
        boolean hasEndMarker = false;
        char previousPrefix = ' ';
        for (int index = 1; index < patchLines.length; index++) {
            String line = patchLines[index];
            if (line.equals("\\ No newline at end of file")) {
                hasEndMarker = true;
                oldNoNewline |= previousPrefix != '+';
                continue;
            }
            if (line.isEmpty()) {
                continue;
            }
            char prefix = line.charAt(0);
            require(prefix == '+' || prefix == '-' || prefix == ' ', "Invalid patch body");
            if (prefix != '-') {
                expected.add(line.substring(1));
            }
            if (prefix != '+') {
                restored.add(line.substring(1));
            }
            previousPrefix = prefix;
        }
        String normalized = normalize(content);
        boolean finalNewline = normalized.endsWith("\n");
        List<String> lines = new ArrayList<>(Arrays.asList(normalized.split("\n", -1)));
        if (finalNewline || normalized.isEmpty()) {
            lines.remove(lines.size() - 1);
        }
        Matcher location = HUNK.matcher(patchLines[0]);
        int position = -1;
        if (location.matches()) {
            int start = Integer.parseInt(location.group(3));
            position = "0".equals(location.group(4)) ? start : Math.max(0, start - 1);
        }
        if (!matchesAt(lines, expected, position)) {
            // Context may shift after unrelated edits, but an ambiguous match
            // cannot safely identify which occurrence belongs to this session.
            require(!expected.isEmpty(), "Deletion patch has no recorded position");
            position = -1;
            for (int candidate = 0; candidate <= lines.size() - expected.size(); candidate++) {
                if (matchesAt(lines, expected, candidate)) {
                    require(position == -1, "Patch context is ambiguous in the current file");
                    position = candidate;
                }
            }
            require(position >= 0, "Current file no longer matches the patch context");
        }
        boolean touchesEnd = position + expected.size() == lines.size();
        lines.subList(position, position + expected.size()).clear();
        lines.addAll(position, restored);
        if (touchesEnd && hasEndMarker) {
            finalNewline = !oldNoNewline;
        }
        String result = String.join("\n", lines) + (finalNewline && !lines.isEmpty() ? "\n" : "");
        return content.contains("\r\n") ? result.replace("\n", "\r\n") : result;
    }

    private static boolean matchesAt(List<String> lines, List<String> expected, int position) {
        return position >= 0 && position + expected.size() <= lines.size()
                && lines.subList(position, position + expected.size()).equals(expected);
    }

    private static String string(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull() ? object.get(key).getAsString() : "";
    }

    private static String normalize(String content) {
        return content.replace("\r\n", "\n");
    }

    private static void require(boolean condition, String error) {
        if (!condition) {
            throw new IllegalArgumentException(error);
        }
    }
}
