package com.github.claudecodegui.cli.codex;

import com.github.claudecodegui.cli.CliSendRequest;
import com.github.claudecodegui.cli.CliSessionCallback;
import com.github.claudecodegui.cli.common.CliAttachmentHandler;
import com.github.claudecodegui.cli.common.CliMcpConfig;
import com.github.claudecodegui.cli.common.CliProcessHandle;
import com.github.claudecodegui.session.runtime.CodexCliResolver;
import com.github.claudecodegui.settings.CodemossSettingsService;
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
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Codex CLI 会话：每个 Tab 独立实例，使用 codex exec --json（one-shot per turn）。
 * 通过 resume --last 实现多轮连续对话。
 * 完全不依赖 SDK / ai-bridge。
 */
public class CodexCliSession {

    private static final Logger LOG = Logger.getInstance(CodexCliSession.class);

    private final String tabId;
    private final Gson gson = new Gson();
    private final CliAttachmentHandler attachmentHandler = new CliAttachmentHandler();
    private final CliMcpConfig mcpConfig;

    // 当前 thread_id（从 thread.started 事件获取）
    private volatile String threadId;
    // 当前活跃进程（用于中断）
    private volatile CliProcessHandle activeHandle;

    public CodexCliSession(String tabId) {
        this.tabId = tabId;
        this.mcpConfig = new CliMcpConfig(tabId);
        this.mcpConfig.initialize();
    }

    public CompletableFuture<Void> send(CliSendRequest request, CliSessionCallback callback) {
        return CompletableFuture.runAsync(() -> {
            List<File> tempFiles = new ArrayList<>();
            Process process = null;
            try {
                List<File> images = attachmentHandler.processForCodex(request.attachments(), tempFiles);
                List<String> cmd = buildCommand(request, images);
                LOG.info("[CodexCliSession][" + tabId + "] Command: " + String.join(" ", cmd));

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.redirectErrorStream(true);
                if (request.cwd() != null && !request.cwd().isBlank()) {
                    File cwd = new File(request.cwd());
                    if (cwd.isDirectory()) pb.directory(cwd);
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
                        if (!line.isBlank()) parseEvent(line, callback, assistantContent);
                    }
                }

                process.waitFor();
                int exitCode = process.exitValue();
                boolean interrupted = activeHandle.wasInterrupted();

                if (interrupted) {
                    callback.onComplete(false, assistantContent.toString(), "User interrupted");
                } else if (exitCode == 0) {
                    callback.onMessage("stream_end", "");
                    callback.onMessage("message_end", "");
                    callback.onComplete(true, assistantContent.toString(), null);
                } else {
                    String err = "Codex CLI exited with code: " + exitCode;
                    callback.onError(err);
                    callback.onComplete(false, assistantContent.toString(), err);
                }
            } catch (Exception e) {
                LOG.warn("[CodexCliSession][" + tabId + "] send failed", e);
                callback.onError(e.getMessage());
                callback.onComplete(false, null, e.getMessage());
            } finally {
                activeHandle = null;
                cleanupTempFiles(tempFiles);
            }
        });
    }

    public void interrupt() {
        CliProcessHandle h = activeHandle;
        if (h != null) h.interrupt();
    }

    public void dispose() {
        interrupt();
        mcpConfig.cleanup();
    }

    public String getThreadId() {
        return threadId;
    }

    // ── event parsing ────────────────────────────────────────────────────────

    private void parseEvent(String line, CliSessionCallback callback, StringBuilder assistantContent) {
        try {
            JsonObject event = gson.fromJson(line, JsonObject.class);
            if (event == null) return;
            String type = getString(event, "type");
            if (type == null) return;

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
                case "item.completed" -> {
                    if (event.has("item") && event.get("item").isJsonObject()) {
                        JsonObject item = event.getAsJsonObject("item");
                        String itemType = getString(item, "type");
                        if ("agent_message".equals(itemType)) {
                            String text = getString(item, "text");
                            if (text != null && !text.isEmpty()) {
                                assistantContent.append(text);
                                callback.onMessage("content_delta", text);
                                // 构造 assistant 消息
                                JsonObject raw = buildAssistantMessage(text);
                                callback.onMessage("assistant", raw.toString());
                            }
                        }
                    }
                }
                case "turn.completed" -> {
                    if (event.has("usage") && event.get("usage").isJsonObject()) {
                        callback.onMessage("usage", event.getAsJsonObject("usage").toString());
                    }
                }
                case "error" -> {
                    String msg = getString(event, "message");
                    if (msg == null) msg = event.toString();
                    callback.onError(msg);
                }
                default -> {
                    // item.started, thread.* 等忽略
                }
            }
        } catch (Exception e) {
            // 非 JSON 行：当作纯文本 delta
            assistantContent.append(line).append('\n');
            callback.onMessage("content_delta", line + "\n");
        }
    }

    private JsonObject buildAssistantMessage(String text) {
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        raw.add("message", message);
        return raw;
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
            for (String p : request.fileTagPaths()) sb.append("- ").append(p).append('\n');
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
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) return null;
        JsonElement el = obj.get(key);
        return el.isJsonPrimitive() ? el.getAsString() : el.toString();
    }

    private static void cleanupTempFiles(List<File> files) {
        for (File f : files) {
            try {
                if (f != null && f.exists()) f.delete();
            } catch (Exception ignored) {
            }
        }
    }
}
