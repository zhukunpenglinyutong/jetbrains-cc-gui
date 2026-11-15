package com.github.claudecodegui.provider.omp;

import com.github.claudecodegui.util.WslPathUtil;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.File;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Maps omp tool calls and their results onto the Claude tool shapes the webview renders
 * ({@code TodoWrite}, {@code Edit}, {@code Write}, {@code Task}).
 *
 * <p>The live bridge stream applies the same rules (contract section 4), so a restored
 * session must render like the live one. Every case whose preconditions fail returns the
 * call and its result unchanged.</p>
 */
final class OmpToolMapper {

    private static final Pattern URL_SCHEME = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*://");
    private static final Pattern WINDOWS_ABSOLUTE = Pattern.compile("^[a-zA-Z]:[\\\\/].*");
    private static final Pattern DRIVE_PREFIX = Pattern.compile("^[A-Za-z]:[\\\\/]");
    private static final Pattern CONTROL_CHARS = Pattern.compile("[\\u0000-\\u001F\\u007F]");
    private static final Pattern UNICODE_SPACES = Pattern.compile("[\\u00A0\\u2000-\\u200A\\u202F\\u205F\\u3000]");
    private static final Pattern DIFF_LINE = Pattern.compile("^([ +\\-])\\s*(\\d{1,9})\\|(.*)$", Pattern.DOTALL);
    private static final Pattern PATH_HEADER =
            Pattern.compile("^\\[([^\\]#\\n]+)#[0-9A-Fa-f]{4}\\]", Pattern.MULTILINE);

    private OmpToolMapper() {
    }

    /** A tool result as stored in the session file. {@code text} is what the plugin shows. */
    static final class ToolResult {
        final String text;
        final JsonObject details;
        final boolean isError;

        ToolResult(String text, JsonObject details, boolean isError) {
            this.text = text != null ? text : "";
            this.details = details;
            this.isError = isError;
        }
    }

    /**
     * Claude-shaped blocks for one omp call. {@code results} is empty while the call has no result.
     */
    static final class Mapped {
        final List<JsonObject> toolUses = new ArrayList<>();
        final List<JsonObject> toolResults = new ArrayList<>();
    }

    /** {@code sid(0) = id}, {@code sid(k) = id#(k+1)} for {@code k >= 1}. */
    static String sid(String id, int k) {
        return k == 0 ? id : id + "#" + (k + 1);
    }

    /**
     * @param result the matching result, or null when the session ends before it arrives
     * @param cwd    session working directory used to resolve relative paths, or null
     * @param home   user home used to expand {@code ~}, or null
     */
    static Mapped map(String id, String name, JsonObject args, ToolResult result, String cwd, String home) {
        JsonObject safeArgs = args != null ? args : new JsonObject();
        Mapped mapped = null;
        if ("todo".equals(name)) {
            mapped = mapTodo(id, result);
        } else if ("edit".equals(name)) {
            mapped = mapEdit(id, result);
        } else if ("write".equals(name)) {
            mapped = mapWrite(id, safeArgs, result, cwd, home);
        } else if ("task".equals(name)) {
            mapped = mapTask(id, safeArgs, result);
        }
        if (mapped != null) {
            return mapped;
        }
        return unchanged(id, name, safeArgs, result);
    }

    private static Mapped unchanged(String id, String name, JsonObject args, ToolResult result) {
        JsonObject input = args;
        if ("edit".equals(name)) {
            String filePath = failedEditPath(args);
            if (filePath != null && !args.has("file_path")) {
                input = args.deepCopy();
                input.addProperty("file_path", filePath);
            }
        }
        Mapped mapped = new Mapped();
        mapped.toolUses.add(toolUse(id, name, input));
        if (result != null) {
            mapped.toolResults.add(toolResult(id, result.text, result.isError));
        }
        return mapped;
    }

    private static String failedEditPath(JsonObject args) {
        String path = string(args, "path");
        if (path != null) {
            return path;
        }
        String input = string(args, "input");
        if (input == null) {
            return null;
        }
        Matcher m = PATH_HEADER.matcher(input);
        return m.find() ? m.group(1) : null;
    }

    private static Mapped mapTodo(String id, ToolResult result) {
        if (result == null || result.isError || result.details == null) {
            return null;
        }
        JsonElement phasesEl = result.details.get("phases");
        if (phasesEl == null || !phasesEl.isJsonArray()) {
            return null;
        }
        JsonArray todos = new JsonArray();
        for (JsonElement phaseEl : phasesEl.getAsJsonArray()) {
            if (!phaseEl.isJsonObject()) {
                continue;
            }
            JsonElement tasksEl = phaseEl.getAsJsonObject().get("tasks");
            if (tasksEl == null || !tasksEl.isJsonArray()) {
                continue;
            }
            for (JsonElement taskEl : tasksEl.getAsJsonArray()) {
                if (!taskEl.isJsonObject()) {
                    continue;
                }
                JsonObject task = taskEl.getAsJsonObject();
                String content = string(task, "content");
                String status = string(task, "status");
                if (content == null || "abandoned".equals(status)) {
                    continue;
                }
                JsonObject todo = new JsonObject();
                todo.addProperty("content", content);
                todo.addProperty("status", status == null || "blocked".equals(status) ? "pending" : status);
                todo.addProperty("activeForm", content);
                todos.add(todo);
            }
        }
        JsonObject input = new JsonObject();
        input.add("todos", todos);
        Mapped mapped = new Mapped();
        mapped.toolUses.add(toolUse(id, "TodoWrite", input));
        mapped.toolResults.add(toolResult(id, result.text, false));
        return mapped;
    }

    private static Mapped mapEdit(String id, ToolResult result) {
        if (result == null || result.isError || result.details == null) {
            return null;
        }
        List<JsonObject> files = new ArrayList<>();
        JsonElement perFile = result.details.get("perFileResults");
        if (perFile != null && perFile.isJsonArray() && perFile.getAsJsonArray().size() > 0) {
            for (JsonElement el : perFile.getAsJsonArray()) {
                if (el.isJsonObject() && hasPathAndDiff(el.getAsJsonObject())) {
                    files.add(el.getAsJsonObject());
                }
            }
        } else if (hasPathAndDiff(result.details)) {
            files.add(result.details);
        }
        Mapped mapped = new Mapped();
        int k = 0;
        for (JsonObject file : files) {
            String path = string(file, "path");
            for (String[] region : changedRegions(string(file, "diff"))) {
                JsonObject input = new JsonObject();
                input.addProperty("file_path", path);
                input.addProperty("old_string", region[0]);
                input.addProperty("new_string", region[1]);
                String blockId = sid(id, k);
                mapped.toolUses.add(toolUse(blockId, "Edit", input));
                mapped.toolResults.add(toolResult(blockId, k == 0 ? result.text : "", false));
                k++;
            }
        }
        return mapped.toolUses.isEmpty() ? null : mapped;
    }

    private static boolean hasPathAndDiff(JsonObject obj) {
        return string(obj, "path") != null && string(obj, "diff") != null;
    }

    /**
     * Splits a numbered diff into its regions; returns {@code [old, new]} per region that changes text.
     * Context and {@code -} lines carry their line number in the old file, {@code +} lines theirs in the
     * new file. omp prints hunks back to back when it leaves out the unchanged lines between them, so a
     * gap in the line numbers, or any line that is not a diff line (the empty separator included), ends
     * the current region: a region is always a contiguous slice of the file.
     */
    private static List<String[]> changedRegions(String diff) {
        List<String[]> regions = new ArrayList<>();
        List<String> oldLines = new ArrayList<>();
        List<String> newLines = new ArrayList<>();
        // Number the next old-file line (context, '-') and the next new-file line ('+') must have; -1 when unknown.
        long nextOld = -1;
        long nextNew = -1;
        for (String line : diff.split("\n", -1)) {
            String clean = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            Matcher m = DIFF_LINE.matcher(clean);
            if (!m.matches()) {
                flushRegion(regions, oldLines, newLines);
                nextOld = -1;
                nextNew = -1;
                continue;
            }
            String marker = m.group(1);
            long number = Long.parseLong(m.group(2));
            String text = m.group(3);
            long expected = "+".equals(marker) ? nextNew : nextOld;
            if (expected >= 0 && number != expected) {
                flushRegion(regions, oldLines, newLines);
                nextOld = -1;
                nextNew = -1;
            }
            if (!"+".equals(marker)) {
                oldLines.add(text);
                nextOld = number + 1;
            }
            if (!"-".equals(marker)) {
                newLines.add(text);
            }
            if ("+".equals(marker)) {
                nextNew = number + 1;
            } else if (" ".equals(marker) && nextNew >= 0) {
                nextNew++;
            }
        }
        flushRegion(regions, oldLines, newLines);
        return regions;
    }

    private static void flushRegion(List<String[]> regions, List<String> oldLines, List<String> newLines) {
        if (!oldLines.isEmpty() || !newLines.isEmpty()) {
            String oldText = String.join("\n", oldLines);
            String newText = String.join("\n", newLines);
            if (!oldText.equals(newText)) {
                regions.add(new String[]{oldText, newText});
            }
        }
        oldLines.clear();
        newLines.clear();
    }

    private static Mapped mapWrite(String id, JsonObject args, ToolResult result, String cwd, String home) {
        String path = string(args, "path");
        String content = string(args, "content");
        if (path == null || content == null || URL_SCHEME.matcher(path).find()) {
            return null;
        }
        String filePath = null;
        if (result != null && result.details != null) {
            filePath = string(result.details, "resolvedPath");
        }
        if (filePath == null) {
            // omp rewrites some paths before writing; only a plain one is known without the result.
            if (!isPlainPath(path, usesWindowsPathRules(cwd, File.separatorChar == '\\'))) {
                return null;
            }
            filePath = absolute(path, cwd, home);
        }
        JsonObject input = new JsonObject();
        input.addProperty("file_path", filePath);
        input.addProperty("content", content);
        Mapped mapped = new Mapped();
        mapped.toolUses.add(toolUse(id, "Write", input));
        if (result != null) {
            mapped.toolResults.add(toolResult(id, result.text, result.isError));
        }
        return mapped;
    }

    private static Mapped mapTask(String id, JsonObject args, ToolResult result) {
        JsonElement tasksEl = args.get("tasks");
        if (tasksEl == null || !tasksEl.isJsonArray() || tasksEl.getAsJsonArray().size() == 0) {
            return null;
        }
        JsonArray tasks = tasksEl.getAsJsonArray();
        Mapped mapped = new Mapped();
        for (int i = 0; i < tasks.size(); i++) {
            JsonObject entry = tasks.get(i).isJsonObject() ? tasks.get(i).getAsJsonObject() : new JsonObject();
            String description = firstNonEmpty(entry, "name", "id", "description");
            String prompt = firstNonEmpty(entry, "task", "assignment", "prompt", "description");
            String subagent = firstNonEmpty(entry, "agent");
            if (subagent == null) {
                subagent = firstNonEmpty(args, "agent");
            }
            JsonObject input = new JsonObject();
            input.addProperty("description", description != null ? description : "Task " + (i + 1));
            input.addProperty("prompt", prompt != null ? prompt : "");
            input.addProperty("subagent_type", subagent != null ? subagent : "task");
            String blockId = sid(id, i);
            mapped.toolUses.add(toolUse(blockId, "Task", input));
            if (result != null) {
                mapped.toolResults.add(toolResult(blockId, i == 0 ? result.text : "", result.isError));
            }
        }
        return mapped;
    }

    /**
     * Whether omp applied Windows path rules in a session. On a Windows host a POSIX session
     * directory means omp ran in WSL, where it writes POSIX paths as given; OmpHistoryReader
     * reads the session's {@code ~} the same way. Without a session directory the host decides.
     */
    static boolean usesWindowsPathRules(String sessionCwd, boolean windowsHost) {
        return windowsHost && (sessionCwd == null || !sessionCwd.startsWith("/"));
    }

    /**
     * Whether omp writes to {@code path} exactly as written (resolved against the session
     * directory, {@code ~} and {@code ~/} against home). Every other form is rewritten by omp
     * first ({@code @...}, {@code :...}, {@code ~name}, {@code [path#TAG]}, {@code archive:member}, ...),
     * so where it lands is only known from the result.
     *
     * <p>{@code windows} selects omp's Windows rules (see {@link #usesWindowsPathRules}). On
     * Windows omp turns {@code /c/...} into a drive path, and any other leading slash is
     * drive-relative, so no path starting with {@code /} is written as given there.
     */
    static boolean isPlainPath(String path, boolean windows) {
        if (path == null || path.isEmpty() || !path.equals(path.strip())) {
            return false;
        }
        if (CONTROL_CHARS.matcher(path).find() || UNICODE_SPACES.matcher(path).find()
                || URL_SCHEME.matcher(path).find()) {
            return false;
        }
        char first = path.charAt(0);
        if (first == '@' || first == ':' || first == '[' || path.chars().allMatch(c -> c == '/')) {
            return false;
        }
        if (path.startsWith("~") && !"~".equals(path) && !path.startsWith("~/") && !path.startsWith("~\\")) {
            return false;
        }
        if (windows && path.startsWith("/")) {
            return false;
        }
        return (DRIVE_PREFIX.matcher(path).find() ? path.substring(2) : path).indexOf(':') < 0;
    }

    /**
     * {@code abs(p)}: absolute paths stay, {@code ~} expands to home, anything else resolves against cwd.
     * A POSIX base (omp running in WSL or on Linux/macOS) is joined with POSIX rules on every host OS;
     * other bases use the host's rules. {@code ~} without a usable home stays as written.
     */
    static String absolute(String path, String cwd, String home) {
        if (path.startsWith("/") || path.startsWith("\\") || WINDOWS_ABSOLUTE.matcher(path).matches()) {
            return path;
        }
        boolean homeRelative = "~".equals(path) || path.startsWith("~/") || path.startsWith("~\\");
        String base = homeRelative ? home : cwd;
        if (base == null || base.isEmpty()) {
            return path;
        }
        if ("~".equals(path)) {
            return home;
        }
        String relative = homeRelative ? path.substring(2) : path;
        if (base.startsWith("/")) {
            String folded = WslPathUtil.foldPosix(base + "/" + relative);
            return folded != null ? folded : path;
        }
        try {
            return Paths.get(base).resolve(relative).normalize().toString();
        } catch (RuntimeException ignored) {
            // Unparsable path text: keep it as written rather than dropping the call.
            return path;
        }
    }

    private static JsonObject toolUse(String id, String name, JsonObject input) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", name);
        block.add("input", input);
        return block;
    }

    private static JsonObject toolResult(String toolUseId, String content, boolean isError) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("is_error", isError);
        block.addProperty("content", content);
        return block;
    }

    private static String firstNonEmpty(JsonObject obj, String... fields) {
        for (String field : fields) {
            String value = string(obj, field);
            if (value != null && !value.isEmpty()) {
                return value;
            }
        }
        return null;
    }

    /** String value of a string-typed field; null for missing or non-string values. */
    private static String string(JsonObject obj, String field) {
        JsonElement el = obj == null ? null : obj.get(field);
        if (el == null || !el.isJsonPrimitive() || !el.getAsJsonPrimitive().isString()) {
            return null;
        }
        return el.getAsString();
    }
}
