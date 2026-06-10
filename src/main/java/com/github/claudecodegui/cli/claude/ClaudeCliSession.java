package com.github.claudecodegui.cli.claude;

import com.github.claudecodegui.cli.CliSendRequest;
import com.github.claudecodegui.cli.CliSessionCallback;
import com.github.claudecodegui.cli.CliSessionExecutor;
import com.github.claudecodegui.cli.common.CliAttachmentHandler;
import com.github.claudecodegui.cli.common.CliEnvironmentBuilder;
import com.github.claudecodegui.cli.common.CliErrorFormatter;
import com.github.claudecodegui.cli.common.CliMcpConfig;
import com.github.claudecodegui.cli.common.CliProcessHandle;
import com.github.claudecodegui.cli.common.CliSettings;
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
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
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
    private volatile String permissionDir;
    private volatile String cliPermissionSessionId;

    // 当前 session_id（从 stream-json 输出中获取）
    private volatile String sessionId;
    // 当前活跃进程（用于中断）
    private volatile CliProcessHandle activeHandle;
    private final AtomicBoolean userInterrupted = new AtomicBoolean(false);

    public ClaudeCliSession(String tabId) {
        this.tabId = tabId;
        this.mcpConfig = new CliMcpConfig(tabId);
        this.mcpConfig.initialize();
    }

    private static long elapsedMillis(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000_000;
    }

    public void interrupt() {
        userInterrupted.set(true);
        CliProcessHandle h = activeHandle;
        if (h != null) {
            long startNanos = System.nanoTime();
            h.interrupt();
            LOG.info("[TabPerf] ClaudeCliSession.interrupt returned in " + TabPerformanceLogger.elapsedMillis(
                    startNanos) + "ms: tab=" + tabId);
        } else {
            LOG.info("[ClaudeCliSession] Interrupt requested before active process handle was available: tab=" + tabId);
        }
    }

    public void dispose() {
        long startNanos = System.nanoTime();
        interrupt();
        long cleanupStartNanos = System.nanoTime();
        mcpConfig.cleanup();
        LOG.info("[TabPerf] ClaudeCliSession MCP cleanup returned in " + TabPerformanceLogger.elapsedMillis(
                cleanupStartNanos) + "ms: tab=" + tabId);
        LOG.info("[TabPerf] ClaudeCliSession.dispose returned in " + TabPerformanceLogger.elapsedMillis(startNanos) + "ms: tab=" + tabId);
    }

    public String getSessionId() {
        return sessionId;
    }

    // ── output reading ───────────────────────────────────────────────────────

    private static String previewLine(String line) {
        if (line == null) {
            return "";
        }
        String compact = line.replace('\n', ' ')
                .replace('\r', ' ');
        return compact.length() > 240 ? compact.substring(0, 240) + "..." : compact;
    }

    private static String previewPrompt(String prompt) {
        if (prompt == null) {
            return "";
        }
        String compact = prompt.replace('\n', ' ')
                .replace('\r', ' ');
        return compact.length() > 500 ? compact.substring(0, 500) + "..." : compact;
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
        ClaudeCliModelResolver.ResolvedModel profile = ClaudeCliModelResolver.resolveProfile(request.model());
        return buildCommand(
                cliPath,
                request,
                addDirs,
                profile,
                mcpConfig.hasServers(),
                mcpConfig.getConfigFilePath(),
                sessionId
        );
    }

    static List<String> buildCommand(
            String cliPath,
            CliSendRequest request,
            List<String> addDirs,
            ClaudeCliModelResolver.ResolvedModel profile,
            boolean hasMcpServers,
            String mcpConfigFilePath,
            String currentSessionId
    ) {
        List<String> cmd = new ArrayList<>();
        cmd.add(cliPath);
        cmd.add("-p");
        cmd.add("--output-format");
        cmd.add("stream-json");
        cmd.add("--verbose");
        if (profile.capabilities().supportsPartialMessages()) {
            cmd.add("--include-partial-messages");
        }

        ClaudeCliPermissionMode.apply(cmd, request.permissionMode());

        String model = profile.model();
        if (model != null && !model.isBlank()) {
            cmd.add("--model");
            cmd.add(model);
        }

        if (profile.capabilities().supportsEffort()
                && request.reasoningEffort() != null && !request.reasoningEffort()
                .isBlank()) {
            cmd.add("--effort");
            cmd.add(request.reasoningEffort());
        }

        // per-tab MCP 配置
        if (profile.capabilities().supportsMcp() && hasMcpServers) {
            cmd.add("--mcp-config");
            cmd.add(mcpConfigFilePath);
        }

        // 附件父目录授权，使 Claude 可以读取持久化目录下的图片
        if (profile.capabilities().supportsAddDir() && addDirs != null) {
            for (String dir : addDirs) {
                cmd.add("--add-dir");
                cmd.add(dir);
            }
        }

        // 续接已有会话（优先使用本地保存的 sessionId，其次用请求传入的）
        String resumeId = currentSessionId != null ? currentSessionId : request.sessionId();
        if (resumeId != null && !resumeId.isBlank()) {
            cmd.add("--resume");
            cmd.add(resumeId);
        }

        return cmd;
    }

    private static void writePromptToStdin(Process process, String prompt) throws Exception {
        try (OutputStreamWriter writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
            writer.write(prompt != null ? prompt : "");
            writer.flush();
        }
    }

    private String buildPrompt(CliSendRequest request, List<CliAttachmentHandler.ContentBlock> blocks) {
        StringBuilder sb = new StringBuilder(request.message() != null ? request.message() : "");

        // 附件：图片保留 [Image #N: path] 历史锚点，并显式提示 Claude CLI 用 Read 读取真实文件。
        int imageIndex = 0;
        for (CliAttachmentHandler.ContentBlock block : blocks) {
            if (block.kind() == CliAttachmentHandler.ContentBlock.Kind.IMAGE) {
                imageIndex++;
                String path = block.file()
                        .getAbsolutePath()
                        .replace('\\', '/');
                sb.append("\n\n[Image #")
                        .append(imageIndex)
                        .append(": ")
                        .append(path)
                        .append("]\n")
                        .append("Use the Read tool to inspect this image file, ")
                        .append("then answer using its visible content: ")
                        .append(path);
            } else if (block.text() != null) {
                sb.append("\n\n")
                        .append(block.text());
            }
        }

        if (request.openedFiles() != null && request.openedFiles()
                .size() > 0) {
            sb.append("\n\n## Opened Files Context\n\n")
                    .append(gson.toJson(request.openedFiles()));
        }
        if (request.fileTagPaths() != null && !request.fileTagPaths()
                .isEmpty()) {
            sb.append("\n\n## Referenced Files\n\n");
            for (String p : request.fileTagPaths()) {
                sb.append("- ")
                        .append(p)
                        .append('\n');
            }
        }
        if (request.agentPrompt() != null && !request.agentPrompt()
                .isBlank()) {
            sb.append("\n\n## Agent Role and Instructions\n\n")
                    .append(request.agentPrompt());
        }
        return sb.toString();
    }

    /**
     * 收集图片附件所在的父目录（去重），用于 --add-dir 授权。
     */
    private List<String> collectAddDirs(List<CliAttachmentHandler.ContentBlock> blocks) {
        Set<String> dirs = new LinkedHashSet<>();
        for (CliAttachmentHandler.ContentBlock block : blocks) {
            if (block.kind() != CliAttachmentHandler.ContentBlock.Kind.IMAGE || block.file() == null) {
                continue;
            }
            File parent = block.file()
                    .getParentFile();
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
        if (obj == null || !obj.has(key) || obj.get(key)
                .isJsonNull()) {
            return null;
        }
        return obj.get(key)
                .getAsString();
    }

    public CompletableFuture<Void> send(CliSendRequest request, CliSessionCallback callback) {
        prepareForSend();
        return CliSessionExecutor.runAsync(() -> {
            long sendStartNanos = System.nanoTime();
            List<File> tempFiles = new ArrayList<>();
            StringBuilder diagnostic = new StringBuilder();
            AtomicBoolean completedWithStructuredError = new AtomicBoolean(false);
            try {
                LOG.info(String.format(
                        "[CliConcurrencyDiag][ClaudeCliSession] send task started: tabId=%s, requestSessionId=%s, currentSessionId=%s, cwd=%s, thread=%s",
                        tabId,
                        request.sessionId() != null ? request.sessionId() : "(new)",
                        sessionId != null ? sessionId : "(none)",
                        request.cwd() != null ? request.cwd() : "(none)",
                        Thread.currentThread().getName()));
                String cliPath = ClaudeCliDetector.getInstance()
                        .findCliExecutable();
                if (cliPath == null) {
                    throw new IllegalStateException("Claude CLI not found");
                }

                // 解析附件:图片落盘以供 prompt 引用,文档读为文本
                String sessionKey = sessionId != null ? sessionId : "epoch-" + tabId;
                List<CliAttachmentHandler.ContentBlock> blocks = attachmentHandler.processForClaude(request.provider(), sessionKey,
                                                                                                    request.attachments(), tempFiles);

                String prompt = buildPrompt(request, blocks);
                List<String> addDirs = collectAddDirs(blocks);
                int imageBlockCount = 0;
                for (CliAttachmentHandler.ContentBlock block : blocks) {
                    if (block.kind() == CliAttachmentHandler.ContentBlock.Kind.IMAGE) {
                        imageBlockCount++;
                    }
                }
                LOG.debug(String.format(
                        "[ClaudeImageDiag][ClaudeCliSession] prompt prepared: tabId=%s, reqAtts=%d, blocks=%d, imgBlocks=%d, addDirs=%s, stdin=true, hasReadInstr=%s, preview=%s",
                        tabId,
                        request.attachments() != null ? request.attachments().size() : 0,
                        blocks.size(), imageBlockCount, addDirs,
                        prompt.contains("Use the Read tool to inspect this image file"),
                        previewPrompt(prompt)));

                List<String> cmd = buildCommand(cliPath, request, prompt, addDirs);
                LOG.info("[ClaudeCliSession][" + tabId + "] Command (prompt via stdin): " + String.join(" ", cmd));

                ProcessBuilder pb = new ProcessBuilder(cmd);
                pb.redirectErrorStream(true);
                Map<String, String> cliEnv = pb.environment();
                cliEnv.clear();
                cliEnv.putAll(CliEnvironmentBuilder.buildBaseEnvironment());
                cliEnv.putAll(CliSettings.readClaudeCliEnvironment());
                cliEnv.put("NO_COLOR", "1");
                CliEnvironmentBuilder.configureClaudePermissionEnv(
                        cliEnv,
                        getPermissionDirectory(),
                        getPermissionSessionId(request),
                        getPermissionSafetyNetMs()
                );
                CliEnvironmentBuilder.configureProjectPath(cliEnv, request.cwd());

                // CWD 设置放在 pb.start() 紧前面，避免 TOCTOU 竞态：
                // 如果目录在 check 和 start 之间被删除，Windows CreateProcess 会报
                // "系统找不到指定的路径" (ERROR_PATH_NOT_FOUND)。
                if (request.cwd() != null && !request.cwd().isBlank()) {
                    File cwd = new File(request.cwd());
                    if (cwd.isDirectory()) {
                        pb.directory(cwd);
                    } else {
                        LOG.warn("[ClaudeCliSession][" + tabId + "] CWD does not exist, falling back to home: " + request.cwd());
                        File homeDir = new File(System.getProperty("user.home"));
                        if (homeDir.isDirectory()) {
                            pb.directory(homeDir);
                        }
                    }
                }

                LOG.info("[CliConcurrencyDiag][ClaudeCliSession] starting process" + ": tabId=" + tabId + ", elapsedMs=" + elapsedMillis(
                        sendStartNanos) + ", thread=" + Thread.currentThread()
                        .getName());
                Process process = pb.start();
                LOG.info("[CliConcurrencyDiag][ClaudeCliSession] process started" + ": tabId=" + tabId + ", elapsedMs=" + elapsedMillis(
                        sendStartNanos) + ", thread=" + Thread.currentThread()
                        .getName());
                writePromptToStdin(process, prompt);
                LOG.debug(
                        "[CliConcurrencyDiag][ClaudeCliSession] prompt written to stdin" + ": tabId=" + tabId + ", promptChars=" + prompt.length() + ", elapsedMs=" + elapsedMillis(
                                sendStartNanos) + ", thread=" + Thread.currentThread()
                                .getName());
                activeHandle = new CliProcessHandle(process, "claude-tab-" + tabId);

                AtomicBoolean interruptHandled = new AtomicBoolean(false);
                readOutput(callback, diagnostic, sendStartNanos, completedWithStructuredError, interruptHandled);

                process.waitFor();
                int exitCode = process.exitValue();
                boolean interrupted = wasInterrupted();
                LOG.info(
                        "[CliConcurrencyDiag][ClaudeCliSession] process exited" + ": tabId=" + tabId + ", exitCode=" + exitCode + ", " +
                                "interrupted=" + interrupted + ", elapsedMs=" + elapsedMillis(
                                sendStartNanos) + ", thread=" + Thread.currentThread()
                                .getName());

                if (shouldEmitInterruptedCompletion(interruptHandled)) {
                    callback.onInterrupted(null, "__I18N__:chat.requestInterrupted");
                } else if (shouldReportExitError(exitCode, completedWithStructuredError.get())) {
                    String err = buildExitError(exitCode, diagnostic);
                    callback.onError(err);
                    callback.onComplete(false, null, err);
                }
            } catch (Exception e) {
                LOG.warn("[ClaudeCliSession][" + tabId + "] send failed", e);
                if (wasInterrupted()) {
                    callback.onInterrupted(null, "__I18N__:chat.requestInterrupted");
                } else {
                    callback.onError(e.getMessage());
                    callback.onComplete(false, null, e.getMessage());
                }
            } finally {
                activeHandle = null;
                cleanupTempFiles(tempFiles);
                userInterrupted.set(false);
            }
        });
    }

    void prepareForSend() {
        userInterrupted.set(false);
    }

    private void readOutput(CliSessionCallback callback, StringBuilder diagnostic, long sendStartNanos,
                            AtomicBoolean completedWithStructuredError, AtomicBoolean interruptHandled) throws Exception {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(gson);
        parser.resetState();
        StringBuilder assistantContent = new StringBuilder();
        SDKResult result = new SDKResult();
        AtomicBoolean hadError = new AtomicBoolean(false);
        AtomicBoolean firstOutputLogged = new AtomicBoolean(false);

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

        try (BufferedReader reader = new BufferedReader(new InputStreamReader(activeHandle.process()
                                                                                      .getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (firstOutputLogged.compareAndSet(false, true)) {
                    LOG.info(
                            "[CliConcurrencyDiag][ClaudeCliSession] first stdout line" + ": tabId=" + tabId + ", elapsedMs=" + elapsedMillis(
                                    sendStartNanos) + ", preview=" + previewLine(line) + ", thread=" + Thread.currentThread()
                                    .getName());
                }
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
                    boolean success = !hadError.get() && result.success;
                    completedWithStructuredError.set(!success && result.error != null && !result.error.isBlank());
                    callback.onComplete(success, success ? assistantContent.toString() : null, success ? null : result.error);
                    return;
                }
            }
        }

        // 进程 stdout 结束但没有 result 事件
        boolean interrupted = wasInterrupted();
        if (interrupted) {
            interruptHandled.set(true);
            callback.onInterrupted(assistantContent.toString(), "__I18N__:chat.requestInterrupted");
        } else if (!hadError.get() && !assistantContent.isEmpty()) {
            callback.onMessage("stream_end", "");
            callback.onMessage("message_end", "");
            callback.onComplete(true, assistantContent.toString(), null);
        } else {
            callback.onComplete(result.success, assistantContent.toString(), result.error);
        }
    }

    boolean wasInterrupted() {
        CliProcessHandle handle = activeHandle;
        return userInterrupted.get() || (handle != null && handle.wasInterrupted());
    }

    boolean shouldEmitInterruptedCompletion(AtomicBoolean interruptHandled) {
        return wasInterrupted() && (interruptHandled == null || !interruptHandled.get());
    }

    boolean shouldReportExitError(int exitCode, boolean completedWithStructuredError) {
        return exitCode != 0 && !completedWithStructuredError && !wasInterrupted();
    }

    private String getPermissionDirectory() {
        String cached = permissionDir;
        if (cached != null) {
            return cached;
        }
        Path dir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
        try {
            Files.createDirectories(dir);
        } catch (Exception e) {
            LOG.warn("[ClaudeCliSession] Failed to prepare permission dir: " + dir + " (" + e.getMessage() + ")");
        }
        permissionDir = dir.toAbsolutePath().toString();
        return permissionDir;
    }

    private String getPermissionSessionId(CliSendRequest request) {
        if (request.permissionSessionId() != null && !request.permissionSessionId().isBlank()) {
            return request.permissionSessionId();
        }
        String cached = cliPermissionSessionId;
        if (cached != null && !cached.isBlank()) {
            return cached;
        }
        String generated = java.util.UUID.randomUUID().toString();
        cliPermissionSessionId = generated;
        return generated;
    }

    private long getPermissionSafetyNetMs() {
        return CliSettings.getClaudePermissionSafetyNetMs();
    }

}
