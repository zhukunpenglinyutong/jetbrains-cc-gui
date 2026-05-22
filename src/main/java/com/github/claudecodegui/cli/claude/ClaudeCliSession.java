package com.github.claudecodegui.cli.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.cli.CliSendRequest;
import com.github.claudecodegui.cli.CliSessionCallback;
import com.github.claudecodegui.cli.CliSessionExecutor;
import com.github.claudecodegui.cli.common.CliAttachmentHandler;
import com.github.claudecodegui.cli.common.CliErrorFormatter;
import com.github.claudecodegui.cli.common.CliMcpConfig;
import com.github.claudecodegui.cli.common.CliProcessHandle;
import com.github.claudecodegui.provider.claude.ClaudeCliDetector;
import com.github.claudecodegui.provider.claude.ClaudeCliStreamParser;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.ui.toolwindow.TabPerformanceLogger;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Claude CLI 会话：每个 Tab 独立实例，使用 one-shot 模式（每轮消息启动独立进程）。
 * 通过 --resume 实现多轮连续对话，完全兼容 Windows。
 */
public class ClaudeCliSession {

    private static final Logger LOG = Logger.getInstance(ClaudeCliSession.class);

    private final String tabId;
    private final Gson gson = new Gson();
    private final CliAttachmentHandler attachmentHandler = new CliAttachmentHandler();
    private final CliMcpConfig mcpConfig;
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    // 当前 session_id（从 stream-json 输出中获取）
    private volatile String sessionId;
    // 当前活跃进程（用于中断）
    private volatile CliProcessHandle activeHandle;

    public ClaudeCliSession(String tabId) {
        this.tabId = tabId;
        this.mcpConfig = new CliMcpConfig(tabId);
        this.mcpConfig.initialize();
    }

    public CompletableFuture<Void> send(CliSendRequest request, CliSessionCallback callback) {
        return CliSessionExecutor.runAsync(() -> {
            List<File> tempFiles = new ArrayList<>();
            StringBuilder diagnostic = new StringBuilder();
            try {
                String cliPath = ClaudeCliDetector.getInstance().findCliExecutable();
                if (cliPath == null) {
                    throw new IllegalStateException("Claude CLI not found");
                }

                // 解析附件:图片落盘以供 prompt 引用,文档读为文本
                String sessionKey = sessionId != null ? sessionId : "epoch-" + tabId;
                List<CliAttachmentHandler.ContentBlock> blocks =
                        attachmentHandler.processForClaude(request.provider(), sessionKey, request.attachments(), tempFiles);

                String prompt = buildPrompt(request, blocks);
                List<String> addDirs = collectAddDirs(blocks);

                List<String> cmd = buildCommand(cliPath, request, prompt, addDirs);
                LOG.info("[ClaudeCliSession][" + tabId + "] Command: " + String.join(" ", cmd));

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.redirectErrorStream(true);
                if (request.cwd() != null && !request.cwd().isBlank()) {
                    File cwd = new File(request.cwd());
                    if (cwd.isDirectory()) {
                        pb.directory(cwd);
                    }
                }
                pb.environment().put("NO_COLOR", "1");
                envConfigurator.configurePermissionEnv(pb.environment());
                envConfigurator.configureProjectPath(pb.environment(), request.cwd());

                Process process = pb.start();
                process.getOutputStream().close();
                activeHandle = new CliProcessHandle(process, "claude-tab-" + tabId);

                readOutput(callback, diagnostic);

                process.waitFor();
                int exitCode = process.exitValue();
                boolean interrupted = activeHandle.wasInterrupted();

                if (interrupted) {
                    callback.onComplete(false, null, "User interrupted");
                } else if (exitCode != 0) {
                    String err = buildExitError(exitCode, diagnostic);
                    callback.onError(err);
                    callback.onComplete(false, null, err);
                }
            } catch (Exception e) {
                LOG.warn("[ClaudeCliSession][" + tabId + "] send failed", e);
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
        if (h != null) {
            long startNanos = System.nanoTime();
            h.interrupt();
            LOG.info("[TabPerf] ClaudeCliSession.interrupt returned in "
                    + TabPerformanceLogger.elapsedMillis(startNanos) + "ms: tab=" + tabId);
        }
    }

    public void dispose() {
        long startNanos = System.nanoTime();
        interrupt();
        long cleanupStartNanos = System.nanoTime();
        mcpConfig.cleanup();
        LOG.info("[TabPerf] ClaudeCliSession MCP cleanup returned in "
                + TabPerformanceLogger.elapsedMillis(cleanupStartNanos) + "ms: tab=" + tabId);
        LOG.info("[TabPerf] ClaudeCliSession.dispose returned in "
                + TabPerformanceLogger.elapsedMillis(startNanos) + "ms: tab=" + tabId);
    }

    public String getSessionId() {
        return sessionId;
    }

    // ── output reading ───────────────────────────────────────────────────────

    private void readOutput(CliSessionCallback callback, StringBuilder diagnostic) throws Exception {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(gson);
        parser.resetState();
        StringBuilder assistantContent = new StringBuilder();
        SDKResult result = new SDKResult();
        AtomicBoolean hadError = new AtomicBoolean(false);

        MessageCallback mcb = new MessageCallback() {
            @Override
            public void onMessage(String type, String content) {
                if ("session_id".equals(type) && content != null && !content.isBlank()) {
                    sessionId = content;
                }
                callback.onMessage(type, content);
            }

            @Override
            public void onError(String error) {
                hadError.set(true);
                callback.onError(error);
            }

            @Override
            public void onComplete(SDKResult r) {
                // 由 readOutput 统一触发
            }
        };

        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(activeHandle.process().getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                CliErrorFormatter.appendDiagnosticLine(diagnostic, line);
                parser.parseLine(line, mcb, result, assistantContent, hadError, false);

                // result 事件 = 本轮结束
                if (isResultLine(line)) {
                    if (sessionId != null) {
                        callback.onMessage("session_id", sessionId);
                    }
                    callback.onComplete(!hadError.get(), assistantContent.toString(),
                            hadError.get() ? result.error : null);
                    return;
                }
            }
        }

        // 进程 stdout 结束但没有 result 事件
        boolean interrupted = activeHandle.wasInterrupted();
        if (interrupted) {
            callback.onComplete(false, assistantContent.toString(), "User interrupted");
        } else if (!hadError.get() && !assistantContent.isEmpty()) {
            callback.onMessage("stream_end", "");
            callback.onMessage("message_end", "");
            callback.onComplete(true, assistantContent.toString(), null);
        } else {
            callback.onComplete(result.success, assistantContent.toString(), result.error);
        }
    }

    private static String buildExitError(int exitCode, StringBuilder diagnostic) {
        return CliErrorFormatter.formatExitError("Claude", exitCode, diagnostic);
    }

    private boolean isResultLine(String line) {
        try {
            JsonObject obj = gson.fromJson(line, JsonObject.class);
            return obj != null && "result".equals(getString(obj, "type"));
        } catch (Exception e) {
            return false;
        }
    }

    // ── command builder ──────────────────────────────────────────────────────

    private List<String> buildCommand(String cliPath, CliSendRequest request, String prompt, List<String> addDirs) {
        List<String> cmd = new ArrayList<>();
        cmd.add(cliPath);
        cmd.add("-p");
        cmd.add("--output-format");
        cmd.add("stream-json");
        cmd.add("--verbose");
        cmd.add("--include-partial-messages");

        ClaudeCliPermissionMode.apply(cmd, request.permissionMode());

        String model = ClaudeCliModelResolver.resolve(request.model());
        if (model != null && !model.isBlank()) {
            cmd.add("--model");
            cmd.add(model);
        }

        if (request.reasoningEffort() != null && !request.reasoningEffort().isBlank()) {
            cmd.add("--effort");
            cmd.add(request.reasoningEffort());
        }

        // per-tab MCP 配置
        if (mcpConfig.hasServers()) {
            cmd.add("--mcp-config");
            cmd.add(mcpConfig.getConfigFilePath());
        }

        // 附件父目录授权，使 Claude 可以读取持久化目录下的图片
        if (addDirs != null) {
            for (String dir : addDirs) {
                cmd.add("--add-dir");
                cmd.add(dir);
            }
        }

        // 续接已有会话（优先使用本地保存的 sessionId，其次用请求传入的）
        String resumeId = sessionId != null ? sessionId : request.sessionId();
        if (resumeId != null && !resumeId.isBlank()) {
            cmd.add("--resume");
            cmd.add(resumeId);
        }

        // 消息作为位置参数
        cmd.add("--");
        cmd.add(prompt);
        return cmd;
    }

    private String buildPrompt(CliSendRequest request, List<CliAttachmentHandler.ContentBlock> blocks) {
        StringBuilder sb = new StringBuilder(request.message() != null ? request.message() : "");

        // 附件：图片用文件路径引用，文档用文本内容
        int imageIndex = 0;
        for (CliAttachmentHandler.ContentBlock block : blocks) {
            if (block.kind() == CliAttachmentHandler.ContentBlock.Kind.IMAGE) {
                imageIndex++;
                String path = block.file().getAbsolutePath().replace('\\', '/');
                sb.append("\n\n[Image #").append(imageIndex).append("]\n")
                        .append("Referenced image: ").append(path);
            } else if (block.text() != null) {
                sb.append("\n\n").append(block.text());
            }
        }

        if (request.openedFiles() != null && request.openedFiles().size() > 0) {
            sb.append("\n\n## Opened Files Context\n\n").append(gson.toJson(request.openedFiles()));
        }
        if (request.fileTagPaths() != null && !request.fileTagPaths().isEmpty()) {
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

    /** 收集图片附件所在的父目录（去重），用于 --add-dir 授权。 */
    private List<String> collectAddDirs(List<CliAttachmentHandler.ContentBlock> blocks) {
        Set<String> dirs = new LinkedHashSet<>();
        for (CliAttachmentHandler.ContentBlock block : blocks) {
            if (block.kind() != CliAttachmentHandler.ContentBlock.Kind.IMAGE || block.file() == null) {
                continue;
            }
            File parent = block.file().getParentFile();
            if (parent != null && parent.isDirectory()) {
                dirs.add(parent.getAbsolutePath());
            }
        }
        return new ArrayList<>(dirs);
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

    private static String getString(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        return obj.get(key).getAsString();
    }
}
