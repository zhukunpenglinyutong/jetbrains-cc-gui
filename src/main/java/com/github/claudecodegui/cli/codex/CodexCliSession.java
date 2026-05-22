package com.github.claudecodegui.cli.codex;

import com.github.claudecodegui.cli.CliSendRequest;
import com.github.claudecodegui.cli.CliSessionCallback;
import com.github.claudecodegui.cli.common.CliAttachmentHandler;
import com.github.claudecodegui.cli.common.CliErrorFormatter;
import com.github.claudecodegui.cli.common.CliMcpConfig;
import com.github.claudecodegui.cli.common.CliProcessHandle;
import com.github.claudecodegui.session.runtime.CodexCliResolver;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.ui.toolwindow.TabPerformanceLogger;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

/**
 * Codex CLI 会话：每个 Tab 独立实例，使用 codex exec --json（one-shot per turn）。
 * 通过 resume --last 实现多轮连续对话。
 * 完全不依赖 SDK / ai-bridge。
 */
public class CodexCliSession {

    private static final Logger LOG = Logger.getInstance(CodexCliSession.class);
    private static final Pattern POWERSHELL_PROFILE_ERROR_PATTERN = Pattern.compile(
            "(?i)(PowerShell_profile\\.ps1|running scripts is disabled on this system|PSSecurityException|UnauthorizedAccess)"
    );
    private static final Pattern DIAGNOSTIC_HEADER_PATTERN = Pattern.compile(
            "(?i)^\\s*[^\\s:][^:]{0,120}:\\s*$"
    );
    private static final Pattern DIAGNOSTIC_BODY_PATTERN = Pattern.compile(
            "(?i)^(?:Line \\||\\d+\\s*\\|\\s*.+|\\|\\s*[~^]+.*"
            + "|\\|\\s*(?:Cannot find path|The term|Could not find|Cannot bind argument"
            + "|A positional parameter cannot be found|The system cannot find the file specified"
            + "|Access is denied|The directory name is invalid"
            + "|The filename, directory name, or volume label syntax is incorrect"
            + "|Unexpected token|Missing .+|ParserError|Exception|Error).*)$"
    );
    private static final Pattern DIAGNOSTIC_GENERIC_PATTERN = Pattern.compile(
            "(?i)^\\s*.*\\b(?:not recognized as the name of a cmdlet|cannot find path"
            + "|could not find a part of the path|file .* cannot be loaded"
            + "|cannot bind argument|a positional parameter cannot be found"
            + "|the system cannot find the file specified|access is denied"
            + "|the directory name is invalid"
            + "|the filename, directory name, or volume label syntax is incorrect"
            + "|unexpected token|missing .+|parsererror|exception).*$"
    );

    private final String tabId;
    private final Gson gson = new Gson();
    private final CliAttachmentHandler attachmentHandler = new CliAttachmentHandler();
    private final CliMcpConfig mcpConfig;

    // 当前 thread_id（从 thread.started 事件获取）
    private volatile String threadId;
    // 当前活跃进程（用于中断）
    private volatile CliProcessHandle activeHandle;
    private final Map<String, String> assistantTextByItemId = new HashMap<>();
    private final Map<String, String> reasoningTextByItemId = new HashMap<>();
    private final Set<String> emittedToolUseIds = new HashSet<>();
    private final Set<String> emittedThinkingStartIds = new HashSet<>();

    public CodexCliSession(String tabId) {
        this.tabId = tabId;
        this.mcpConfig = new CliMcpConfig(tabId);
        this.mcpConfig.initialize();
    }

    public CompletableFuture<Void> send(CliSendRequest request, CliSessionCallback callback) {
        return CompletableFuture.runAsync(() -> {
            List<File> tempFiles = new ArrayList<>();
            StringBuilder diagnostic = new StringBuilder();
            StringBuilder cliError = new StringBuilder();
            Process process = null;
            try {
                List<File> images = attachmentHandler.processForCodex(request.attachments(), tempFiles);
                List<String> cmd = buildCommand(request, images);
                LOG.info("[CodexCliSession][" + tabId + "] Command: " + String.join(" ", cmd));

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.redirectErrorStream(true);
                if (request.cwd() != null && !request.cwd().isBlank()) {
                    File cwd = new File(request.cwd());
                    if (cwd.isDirectory()) {
                        pb.directory(cwd);
                    }
                }
                pb.environment().put("NO_COLOR", "1");
                if (!request.extraEnv().isEmpty()) {
                    pb.environment().putAll(CodexCliCommandUtils.sanitizeEnv(request.extraEnv()));
                }

                process = pb.start();
                // codex exec 通过 CLI 参数传递 prompt，不需要 stdin
                // 立即关闭 stdin 防止 codex 卡在 "Reading additional input from stdin..."
                process.getOutputStream().close();
                activeHandle = new CliProcessHandle(process, "codex-tab-" + tabId);

                StringBuilder assistantContent = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (!line.isBlank()) {
                            CliErrorFormatter.appendDiagnosticLine(diagnostic, line);
                            parseEvent(line, callback, assistantContent, cliError);
                        }
                    }
                }

                process.waitFor();
                int exitCode = process.exitValue();
                boolean interrupted = activeHandle.wasInterrupted();

                if (interrupted) {
                    callback.onComplete(false, assistantContent.toString(), "User interrupted");
                } else if (exitCode == 0) {
                    if (!cliError.isEmpty()) {
                        String err = CliErrorFormatter.formatError("Codex", cliError.toString());
                        callback.onError(err);
                        callback.onComplete(false, assistantContent.toString(), err);
                    } else {
                        callback.onMessage("stream_end", "");
                        callback.onMessage("message_end", "");
                        callback.onComplete(true, assistantContent.toString(), null);
                    }
                } else {
                    String err = buildExitError(exitCode, diagnostic);
                    callback.onError(err);
                    callback.onComplete(false, assistantContent.toString(), err);
                }
            } catch (Exception e) {
                LOG.warn("[CodexCliSession][" + tabId + "] send failed", e);
                String err = CliErrorFormatter.formatError("Codex", e.getMessage());
                callback.onError(err);
                callback.onComplete(false, null, err);
            } finally {
                activeHandle = null;
                cleanupTempFiles(tempFiles);
            }
        });
    }

    public void interrupt() {
        CliProcessHandle h = activeHandle;
        if (h != null) {
            long startNanos = System.nanoTime();
            h.interrupt();
            LOG.info("[TabPerf] CodexCliSession.interrupt returned in "
                    + TabPerformanceLogger.elapsedMillis(startNanos) + "ms: tab=" + tabId);
        }
    }

    public void dispose() {
        long startNanos = System.nanoTime();
        interrupt();
        long cleanupStartNanos = System.nanoTime();
        mcpConfig.cleanup();
        LOG.info("[TabPerf] CodexCliSession MCP cleanup returned in "
                + TabPerformanceLogger.elapsedMillis(cleanupStartNanos) + "ms: tab=" + tabId);
        LOG.info("[TabPerf] CodexCliSession.dispose returned in "
                + TabPerformanceLogger.elapsedMillis(startNanos) + "ms: tab=" + tabId);
    }

    public String getThreadId() {
        return threadId;
    }

    // ── event parsing ────────────────────────────────────────────────────────

    private void parseEvent(
            String line,
            CliSessionCallback callback,
            StringBuilder assistantContent,
            StringBuilder cliError
    ) {
        try {
            if (shouldIgnoreRawLine(line)) {
                return;
            }
            if (isLikelyDiagnosticLine(line)) {
                if (cliError != null) {
                    CliErrorFormatter.appendDiagnosticLine(cliError, line);
                }
                return;
            }
            JsonObject event = gson.fromJson(line, JsonObject.class);
            if (event == null) {
                return;
            }
            String type = getString(event, "type");
            if (type == null) {
                return;
            }

            switch (type) {
                case "thread.started" -> {
                    String id = getString(event, "thread_id");
                    if (id != null) {
                        threadId = id;
                        callback.onMessage("session_id", id);
                    }
                    callback.onMessage("stream_start", "");
                    callback.onMessage("message_start", "");
                }
                case "turn.started" -> callback.onMessage("message_start", "");
                case "item.started", "item.updated", "item.completed" -> {
                    if (event.has("item") && event.get("item").isJsonObject()) {
                        JsonObject item = event.getAsJsonObject("item");
                        handleItem(type, item, callback, assistantContent);
                    }
                }
                case "turn.completed" -> {
                    if (event.has("usage") && event.get("usage").isJsonObject()) {
                        callback.onMessage("usage", event.getAsJsonObject("usage").toString());
                        callback.onMessage("result", buildUsageResultMessage(event.getAsJsonObject("usage")).toString());
                    }
                }
                case "turn.failed" -> {
                    String msg = extractErrorMessage(event, "Turn failed");
                    if (cliError != null) {
                        CliErrorFormatter.appendDiagnosticLine(cliError, msg);
                    } else {
                        callback.onError(CliErrorFormatter.formatError("Codex", msg));
                    }
                }
                case "error" -> {
                    String msg = getString(event, "message");
                    if (msg == null) {
                        msg = event.toString();
                    }
                    if (cliError != null) {
                        CliErrorFormatter.appendDiagnosticLine(cliError, msg);
                    } else {
                        callback.onError(CliErrorFormatter.formatError("Codex", msg));
                    }
                }
                default -> {
                    // item.started, thread.* 等忽略
                }
            }
        } catch (Exception e) {
            // 非 JSON 行：当作纯文本 delta
            if (shouldIgnoreRawLine(line)) {
                return;
            }
            if (isLikelyDiagnosticLine(line)) {
                if (cliError != null) {
                    CliErrorFormatter.appendDiagnosticLine(cliError, line);
                }
                return;
            }
            assistantContent.append(line).append('\n');
            callback.onMessage("content_delta", line + "\n");
        }
    }

    private void handleItem(
            String eventType,
            JsonObject item,
            CliSessionCallback callback,
            StringBuilder assistantContent
    ) {
        String itemType = getString(item, "type");
        if (itemType == null) {
            return;
        }
        switch (itemType) {
            case "reasoning" -> handleReasoningItem(item, callback);
            case "agent_message" -> handleAgentMessageItem(item, callback, assistantContent);
            case "command_execution" -> handleCommandExecutionItem(eventType, item, callback);
            case "mcp_tool_call" -> handleMcpToolCallItem(eventType, item, callback);
            case "web_search" -> handleWebSearchItem(eventType, item, callback);
            case "file_change" -> handleFileChangeItem(eventType, item, callback);
            case "plan_update" -> handlePlanUpdateItem(eventType, item, callback);
            default -> {}
        }
    }

    private void handleReasoningItem(JsonObject item, CliSessionCallback callback) {
        String text = firstNonBlank(
                getString(item, "text"),
                getString(item, "summary"),
                getString(item, "content")
        );
        if (text == null || text.isEmpty()) {
            return;
        }
        String id = stableItemId(item, "reasoning");
        // 首次遇到该 reasoning item 时发送 thinking 开始信号
        if (emittedThinkingStartIds.add(id)) {
            callback.onMessage("thinking", "");
        }
        String previous = reasoningTextByItemId.getOrDefault(id, "");
        String delta = appendedDelta(previous, text);
        reasoningTextByItemId.put(id, text);
        if (!delta.isEmpty()) {
            callback.onMessage("thinking_delta", delta);
        }
    }

    private void handleAgentMessageItem(
            JsonObject item,
            CliSessionCallback callback,
            StringBuilder assistantContent
    ) {
        String text = getString(item, "text");
        if (text == null || text.isEmpty()) {
            return;
        }
        String id = stableItemId(item, "agent_message");
        String previous = assistantTextByItemId.getOrDefault(id, "");
        String delta = appendedDelta(previous, text);
        assistantTextByItemId.put(id, text);
        if (!delta.isEmpty()) {
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        }
        callback.onMessage("assistant", buildAssistantMessage(text).toString());
    }

    private void handleCommandExecutionItem(String eventType, JsonObject item, CliSessionCallback callback) {
        String id = stableItemId(item, "command_execution");
        String command = extractCommand(item);
        if ("item.started".equals(eventType) || "item.updated".equals(eventType)) {
            emitToolUseOnce(callback, id, "Bash", commandInput(command));
            return;
        }

        emitToolUseOnce(callback, id, "Bash", commandInput(command));
        callback.onMessage("user", buildToolResultMessage(id, isItemError(item), extractCommandOutput(item)).toString());
    }

    private void handleMcpToolCallItem(String eventType, JsonObject item, CliSessionCallback callback) {
        String id = stableItemId(item, "mcp_tool_call");
        String toolName = normalizeMcpToolName(getString(item, "server"), getString(item, "tool"));
        JsonObject input = item.has("arguments") && item.get("arguments").isJsonObject()
                ? item.getAsJsonObject("arguments")
                : new JsonObject();
        if ("item.started".equals(eventType) || "item.updated".equals(eventType)) {
            emitToolUseOnce(callback, id, toolName, input);
            return;
        }

        boolean isError = isItemError(item) || item.has("error");
        emitToolUseOnce(callback, id, toolName, input);
        callback.onMessage("user", buildToolResultMessage(id, isError, extractMcpResult(item)).toString());
    }

    private void handleWebSearchItem(String eventType, JsonObject item, CliSessionCallback callback) {
        // no status toast for web search events
    }

    private void handleFileChangeItem(String eventType, JsonObject item, CliSessionCallback callback) {
        // no status toast for file change events
    }

    private void handlePlanUpdateItem(String eventType, JsonObject item, CliSessionCallback callback) {
        // no status toast for plan update events
    }

    private JsonObject buildAssistantMessage(String text) {
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        raw.add("message", message);
        return raw;
    }

    private JsonObject buildToolUseMessage(String id, String name, JsonObject input) {
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", name);
        block.add("input", input != null ? input : new JsonObject());
        content.add(block);
        message.add("content", content);
        raw.add("message", message);
        return raw;
    }

    private JsonObject buildToolResultMessage(String toolUseId, boolean isError, String contentText) {
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("is_error", isError);
        block.addProperty("content", contentText == null || contentText.isBlank() ? "(no output)" : contentText);
        content.add(block);
        message.add("content", content);
        raw.add("message", message);
        return raw;
    }

    private JsonObject buildUsageResultMessage(JsonObject usage) {
        JsonObject mappedUsage = new JsonObject();
        mappedUsage.addProperty("input_tokens", getInt(usage, "input_tokens"));
        mappedUsage.addProperty("output_tokens", getInt(usage, "output_tokens"));
        mappedUsage.addProperty("cache_creation_input_tokens", 0);
        mappedUsage.addProperty("cache_read_input_tokens", getInt(usage, "cached_input_tokens"));

        JsonObject raw = new JsonObject();
        raw.add("usage", mappedUsage);
        return raw;
    }

    private void emitToolUseOnce(CliSessionCallback callback, String id, String name, JsonObject input) {
        if (!emittedToolUseIds.add(id)) {
            return;
        }
        callback.onMessage("assistant", buildToolUseMessage(id, name, input).toString());
    }

    private JsonObject commandInput(String command) {
        JsonObject input = new JsonObject();
        input.addProperty("command", command);
        input.addProperty("description", commandDescription(command));
        return input;
    }

    // ── command builder ──────────────────────────────────────────────────────

    /**
     * 构造 codex 命令。
     * 注意:codex 0.131.0 中 `codex exec` 与 `codex exec resume` 接受的 flag 集合是不同的:
     *   - exec:        --color / -s --sandbox / -C --cd / --add-dir / -m / -i --image<FILE>... / --json
     *                  `-i, --image <FILE>...` 是 num_args=1.. 贪婪参数,后续位置参数 prompt 会被吞掉,
     *                  因此带图片时需要在 prompt 前插入 `--` 分隔符。
     *   - exec resume: 仅 --last / --all / -m / -i --image<FILE> / --json / -c / 各种 --dangerously-* /
     *                  --skip-git-repo-check / --ephemeral 等;
     *                  resume 子命令 *不接受* --color / --sandbox / -C / --add-dir。
     *                  resume 的 `-i, --image <FILE>` 是单值非贪婪,不需要 `--` 分隔符。
     * `-a, --ask-for-approval` 是 top-level 全局 flag,在 exec 与 exec resume 下都可用。
     */
    private List<String> buildCommand(CliSendRequest request, List<File> images) {
        CodexCliCommandUtils.PermissionSelection perm = CodexCliCommandUtils.selectPermission(
                request.permissionMode(), readSandboxMode(request.cwd()));

        List<String> cmd = new ArrayList<>();
        CodexCliCommandUtils.addCodexExecutable(cmd, CodexCliResolver.findExecutable());
        CodexCliCommandUtils.addCodexGlobalOptions(cmd, perm);

        if (threadId != null) {
            appendResumeArgs(cmd, request, images);
        } else {
            appendExecArgs(cmd, request, images, perm);
        }
        return cmd;
    }

    /** 首次会话:codex exec ... [-- PROMPT] */
    private void appendExecArgs(List<String> cmd, CliSendRequest request, List<File> images,
                                CodexCliCommandUtils.PermissionSelection perm) {
        cmd.add("exec");
        cmd.add("--json");
        cmd.add("--color");
        cmd.add("never");
        cmd.add("--sandbox");
        cmd.add(perm.sandbox());

        if (request.cwd() != null && !request.cwd().isBlank()) {
            cmd.add("-C");
            cmd.add(request.cwd());
        }
        if (request.model() != null && !request.model().isBlank()) {
            cmd.add("-m");
            cmd.add(request.model());
        }
        if (request.reasoningEffort() != null && !request.reasoningEffort().isBlank()) {
            cmd.add("-c");
            cmd.add("model_reasoning_effort=\"" + request.reasoningEffort() + "\"");
        }
        for (File img : images) {
            cmd.add("--image");
            cmd.add(img.getAbsolutePath());
        }

        // exec 子命令的 --image 是贪婪参数,必须用 `--` 分隔位置参数 prompt。
        if (!images.isEmpty()) {
            cmd.add("--");
        }
        cmd.add(buildPrompt(request));
    }

    /** 续接会话:codex exec resume --last ... PROMPT */
    private void appendResumeArgs(List<String> cmd, CliSendRequest request, List<File> images) {
        cmd.add("exec");
        cmd.add("resume");
        cmd.add("--last");
        cmd.add("--json");

        if (request.model() != null && !request.model().isBlank()) {
            cmd.add("-m");
            cmd.add(request.model());
        }
        if (request.reasoningEffort() != null && !request.reasoningEffort().isBlank()) {
            cmd.add("-c");
            cmd.add("model_reasoning_effort=\"" + request.reasoningEffort() + "\"");
        }
        // resume 的 --image 是单值非贪婪,无需 `--` 分隔符。
        for (File img : images) {
            cmd.add("-i");
            cmd.add(img.getAbsolutePath());
        }
        cmd.add(buildPrompt(request));
    }

    private String buildPrompt(CliSendRequest request) {
        StringBuilder sb = new StringBuilder(request.message());
        if (request.openedFiles() != null && request.openedFiles().size() > 0) {
            sb.append("\n\n## Opened Files Context\n\n").append(gson.toJson(request.openedFiles()));
        }
        if (!request.fileTagPaths().isEmpty()) {
            sb.append("\n\n## Referenced Files\n\n");
            for (String p : request.fileTagPaths()) {
                sb.append("- ").append(p).append('\n');
            }
        }
        if (request.agentPrompt() != null && !request.agentPrompt().isBlank()) {
            sb.append("\n\n## Agent Role and Instructions\n\n").append(request.agentPrompt());
        }
        return sb.toString();
    }

    private String readSandboxMode(String cwd) {
        try {
            return new CodemossSettingsService().getCodexSandboxMode(cwd);
        } catch (Exception e) {
            return PlatformUtils.isWindows() ? "danger-full-access" : "workspace-write";
        }
    }

    private static String getString(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(key);
        return el.isJsonPrimitive() ? el.getAsString() : el.toString();
    }

    private static String stableItemId(JsonObject item, String fallback) {
        String id = firstNonBlank(getString(item, "id"), getString(item, "call_id"));
        return id != null ? id : fallback;
    }

    private static String appendedDelta(String previous, String next) {
        String oldText = previous != null ? previous : "";
        String newText = next != null ? next : "";
        if (newText.isEmpty() || newText.equals(oldText)) {
            return "";
        }
        if (oldText.isEmpty()) {
            return newText;
        }
        if (newText.startsWith(oldText)) {
            return newText.substring(oldText.length());
        }
        return newText;
    }

    private static String extractCommand(JsonObject item) {
        String command = firstNonBlank(
                getString(item, "command"),
                getString(item, "cmd"),
                getString(item, "program")
        );
        return command != null ? command : "(unknown command)";
    }

    private static String extractCommandOutput(JsonObject item) {
        String output = firstNonBlank(
                getString(item, "aggregated_output"),
                getString(item, "output"),
                getString(item, "stdout"),
                getString(item, "stderr"),
                getString(item, "result")
        );
        return output != null ? output : "(no output)";
    }

    private static String extractMcpResult(JsonObject item) {
        if (item.has("error") && item.get("error").isJsonObject()) {
            String message = getString(item.getAsJsonObject("error"), "message");
            if (message != null) {
                return message;
            }
        }
        if (!item.has("result") || item.get("result").isJsonNull()) {
            return "(no output)";
        }
        JsonElement result = item.get("result");
        if (result.isJsonPrimitive()) {
            return result.getAsString();
        }
        if (result.isJsonObject()) {
            JsonObject resultObj = result.getAsJsonObject();
            if (resultObj.has("content") && resultObj.get("content").isJsonArray()) {
                JsonArray content = resultObj.getAsJsonArray("content");
                List<String> parts = new ArrayList<>();
                for (JsonElement element : content) {
                    if (element.isJsonObject()) {
                        JsonObject block = element.getAsJsonObject();
                        if ("text".equals(getString(block, "type"))) {
                            String text = getString(block, "text");
                            if (text != null && !text.isBlank()) {
                                parts.add(text);
                            }
                        }
                    }
                }
                if (!parts.isEmpty()) {
                    return String.join("\n", parts);
                }
            }
            if (resultObj.has("structured_content")) {
                return resultObj.get("structured_content").toString();
            }
        }
        return result.toString();
    }

    private static String extractErrorMessage(JsonObject event, String fallback) {
        if (event.has("error")) {
            JsonElement error = event.get("error");
            if (error.isJsonObject()) {
                String message = getString(error.getAsJsonObject(), "message");
                if (message != null) {
                    return message;
                }
            } else if (error.isJsonPrimitive()) {
                return error.getAsString();
            }
        }
        String message = getString(event, "message");
        return message != null ? message : fallback;
    }

    private static boolean isItemError(JsonObject item) {
        String status = getString(item, "status");
        if (status != null && ("failed".equalsIgnoreCase(status) || "error".equalsIgnoreCase(status))) {
            return true;
        }
        if (item.has("is_error") && item.get("is_error").isJsonPrimitive() && item.get("is_error").getAsBoolean()) {
            return true;
        }
        if (item.has("error") && !item.get("error").isJsonNull()) {
            return true;
        }
        if (item.has("exit_code") && item.get("exit_code").isJsonPrimitive()) {
            try {
                return item.get("exit_code").getAsInt() != 0;
            } catch (Exception ignored) {
                return false;
            }
        }
        return false;
    }

    private static String normalizeMcpToolName(String server, String tool) {
        String normalizedServer = server == null || server.isBlank() ? "mcp" : sanitizeToolNamePart(server);
        String normalizedTool = tool == null || tool.isBlank() ? "tool" : sanitizeToolNamePart(tool);
        return "mcp__" + normalizedServer + "__" + normalizedTool;
    }

    private static String sanitizeToolNamePart(String value) {
        return value.trim().replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static String commandDescription(String command) {
        if (command == null || command.isBlank()) {
            return "Run command";
        }
        String trimmed = command.trim();
        if (trimmed.startsWith("git status")) {
            return "Check git status";
        }
        if (trimmed.startsWith("git diff")) {
            return "Inspect git diff";
        }
        if (trimmed.startsWith("ls") || trimmed.contains(" Get-ChildItem")) {
            return "List files";
        }
        return "Run command";
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static int getInt(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return 0;
        }
        try {
            return obj.get(key).getAsInt();
        } catch (Exception ignored) {
            return 0;
        }
    }

    private static boolean shouldIgnoreRawLine(String line) {
        if (line == null) {
            return true;
        }
        String trimmed = line.trim();
        return trimmed.isEmpty() || "Reading additional input from stdin...".equals(trimmed);
    }

    private static boolean isLikelyDiagnosticLine(String line) {
        if (line == null) {
            return false;
        }
        String trimmed = line.trim();
        if (trimmed.isEmpty()) {
            return false;
        }
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            return false;
        }
        if ("Reading additional input from stdin...".equals(trimmed)) {
            return true;
        }
        if (POWERSHELL_PROFILE_ERROR_PATTERN.matcher(trimmed).find()) {
            return true;
        }
        if (DIAGNOSTIC_HEADER_PATTERN.matcher(trimmed).matches()) {
            return true;
        }
        if (DIAGNOSTIC_BODY_PATTERN.matcher(trimmed).matches()) {
            return true;
        }
        if (trimmed.startsWith("At line:")
                || trimmed.startsWith("CategoryInfo :")
                || trimmed.startsWith("FullyQualifiedErrorId :")) {
            return true;
        }
        if (trimmed.matches("(?i)^\\S+\\s*:\\s*The term '.+' is not recognized as the name of a cmdlet.*")) {
            return true;
        }
        return DIAGNOSTIC_GENERIC_PATTERN.matcher(trimmed).matches();
    }

    private static String buildExitError(int exitCode, StringBuilder diagnostic) {
        return CliErrorFormatter.formatExitError("Codex", exitCode, diagnostic);
    }

    private static void cleanupTempFiles(List<File> files) {
        for (File f : files) {
            try {
                if (f != null && f.exists()) {
                    f.delete();
                }
            } catch (Exception ignored) {
            }
        }
    }
}
