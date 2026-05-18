package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Claude CLI 调用桥接器。
 * 直接将 claude CLI 作为 OS 子进程调用，无需 Node.js 中间层。
 * 每个请求是独立进程，内存完全隔离。
 *
 * 命令格式:
 * claude -p --output-format stream-json --verbose --include-partial-messages
 *   --dangerously-skip-permissions [--model X] [--effort X] [--resume ID] -- "prompt"
 */
class ClaudeCliBridge {

    private static final Logger LOG = Logger.getInstance(ClaudeCliBridge.class);

    private final ProcessManager processManager;
    private final ClaudeCliDetector cliDetector;
    private final ClaudeCliStreamParser streamParser;
    private final Gson gson;
    private final EnvironmentConfigurator envConfigurator;

    ClaudeCliBridge(
            ProcessManager processManager,
            ClaudeCliDetector cliDetector,
            ClaudeCliStreamParser streamParser,
            Gson gson,
            EnvironmentConfigurator envConfigurator
    ) {
        this.processManager = processManager;
        this.cliDetector = cliDetector;
        this.streamParser = streamParser;
        this.gson = gson;
        this.envConfigurator = envConfigurator;
    }

    /**
     * 发送消息到 Claude CLI。
     * 与 ClaudeProcessInvoker.sendMessage() 相同签名。
     */
    CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            com.google.gson.JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        AtomicBoolean errorAlreadyReported = new AtomicBoolean(false);
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            long startTime = System.currentTimeMillis();

            List<File> tempFiles = new ArrayList<>();

            // 诊断日志：记录附件到达 CliBridge 的状态
            LOG.info("[CliBridge][DIAG] sendMessage entry, attachments="
                    + (attachments == null ? "NULL" : attachments.size())
                    + ", message length=" + (message != null ? message.length() : 0));

            try {
                // 1. 检测 CLI 二进制
                String cliPath = cliDetector.findCliExecutable();
                if (cliPath == null) {
                    String error = "未找到 claude CLI 可执行文件。请确保已安装 claude code 并在 PATH 中可用。";
                    result.success = false;
                    result.error = error;
                    callback.onError(error);
                    return result;
                }

                // 2. 处理附件：保存到临时文件，指示 Claude 使用 Read 工具读取
                String fullPrompt = message;
                List<String> addDirs = new ArrayList<>();
                if (attachments != null && !attachments.isEmpty()) {
                    LOG.info("[CliBridge][DIAG] Processing " + attachments.size() + " attachments");
                    StringBuilder promptBuilder = new StringBuilder(message);
                    for (int i = 0; i < attachments.size(); i++) {
                        ClaudeSession.Attachment att = attachments.get(i);
                        LOG.info("[CliBridge][DIAG] Attachment[" + i + "]: fileName=" + att.fileName
                                + ", mediaType=" + att.mediaType
                                + ", localPath=" + att.localPath
                                + ", data=" + (att.data != null ? att.data.length() + "chars" : "null")
                                + ", isImage=" + isImageAttachment(att));
                        File tempFile = writeAttachmentToTempFile(att, channelId);
                        LOG.info("[CliBridge][DIAG] writeAttachmentToTempFile returned: "
                                + (tempFile != null ? tempFile.getAbsolutePath() : "NULL"));
                        if (tempFile != null) {
                            tempFiles.add(tempFile);
                            String filePath = tempFile.getAbsolutePath();
                            // Collect unique parent dirs for --add-dir so the Read tool can access them
                            File parentDir = tempFile.getParentFile();
                            if (parentDir != null && parentDir.isDirectory()) {
                                String dirPath = parentDir.getAbsolutePath();
                                if (!addDirs.contains(dirPath)) {
                                    addDirs.add(dirPath);
                                }
                            }
                            if (isImageAttachment(att)) {
                                // Use forward slashes and no quotes to avoid Windows ProcessBuilder
                                // argument escaping issues with embedded double-quotes
                                String safePath = filePath.replace('\\', '/');
                                promptBuilder.append("\n\n[Attached image: ")
                                        .append(att.fileName)
                                        .append("]\nPlease use the Read tool to read the file at: ")
                                        .append(safePath)
                                        .append("\nThen answer the user's question about this image.");
                            } else {
                                String safePath = filePath.replace('\\', '/');
                                promptBuilder.append("\n\n[Attached file: ")
                                        .append(att.fileName)
                                        .append("]\nPlease use the Read tool to read the file at: ")
                                        .append(safePath);
                            }
                        }
                    }
                    fullPrompt = promptBuilder.toString();
                }

                // 3. 构建命令
                List<String> command = buildCliCommand(cliPath, fullPrompt, sessionId, model, reasoningEffort, addDirs);
                LOG.info("[CliBridge][DIAG] fullPrompt length=" + fullPrompt.length()
                        + ", addDirs=" + addDirs);
                LOG.info("[CliBridge][DIAG] fullPrompt content: "
                        + (fullPrompt.length() > 500 ? fullPrompt.substring(0, 500) + "..." : fullPrompt));
                LOG.info("[CliBridge] 命令: " + String.join(" ", command));

                // 4. 创建进程
                ProcessBuilder pb = new ProcessBuilder(command);
                pb.redirectErrorStream(true);

                // 设置工作目录
                if (cwd != null && !cwd.isEmpty()) {
                    File workDir = new File(cwd);
                    if (workDir.exists()) {
                        pb.directory(workDir);
                    }
                }

                // 5. 配置环境
                Map<String, String> env = pb.environment();
                env.put("NO_COLOR", "1");
                envConfigurator.configureProjectPath(env, cwd);
                envConfigurator.configurePermissionEnv(env);

                // 6. 启动进程
                Process process = pb.start();
                LOG.info("[CliBridge] CLI 进程已启动, PID: " + process.pid());
                processManager.registerProcess(channelId, process);

                // 7. 重置解析器状态
                streamParser.resetState();

                // 8. 读取输出
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (line.trim().isEmpty()) {
                            continue;
                        }
                        LOG.debug("[CliBridge] 收到行: " + line);
                        streamParser.parseLine(line, callback, result, assistantContent, hadSendError);
                    }
                }

                // 9. 等待进程退出
                process.waitFor();
                int exitCode = process.exitValue();
                boolean wasInterrupted = processManager.wasInterrupted(channelId);
                LOG.info("[CliBridge] 进程退出, exitCode=" + exitCode
                        + ", wasInterrupted=" + wasInterrupted);

                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();

                if (wasInterrupted) {
                    long elapsed = System.currentTimeMillis() - startTime;
                    LOG.info("[CliBridge] 请求被用户中断 (elapsed: " + elapsed + "ms)");
                    result.error = "User interrupted";
                    callback.onComplete(result);
                } else if (!hadSendError.get()) {
                    if (exitCode == 0) {
                        if (!result.success) {
                            result.success = true;
                        }
                        callback.onComplete(result);
                    } else {
                        String errorMsg = "CLI 进程退出码: " + exitCode;
                        result.success = false;
                        result.error = errorMsg;
                        callback.onError(errorMsg);
                    }
                } else {
                    callback.onComplete(result);
                }

                return result;
            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                errorAlreadyReported.set(true);
                LOG.error("[CliBridge] 执行异常", e);
                callback.onError(e.getMessage());
                return result;
            } finally {
                // 清理临时文件
                cleanupTempFiles(tempFiles);
                // 注意：unregisterProcess 需要 process 引用，这里从 map 中移除
                processManager.unregisterProcess(channelId, processManager.getProcess(channelId));
            }
        }).exceptionally(ex -> {
            if (errorAlreadyReported.get()) {
                return new SDKResult();
            }
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage();
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

    /**
     * 构建 CLI 命令参数列表。
     */
    private List<String> buildCliCommand(String cliPath, String message, String sessionId, String model, String reasoningEffort, List<String> addDirs) {
        List<String> command = new ArrayList<>();
        command.add(cliPath);
        command.add("-p");
        command.add("--output-format");
        command.add("stream-json");
        command.add("--verbose");
        command.add("--include-partial-messages");
        command.add("--dangerously-skip-permissions");

        if (model != null && !model.isEmpty()) {
            command.add("--model");
            command.add(model);
        }

        if (reasoningEffort != null && !reasoningEffort.isEmpty()) {
            command.add("--effort");
            command.add(reasoningEffort);
        }

        // Grant Read tool access to attachment directories (each dir as separate --add-dir flag)
        if (addDirs != null && !addDirs.isEmpty()) {
            for (String dir : addDirs) {
                command.add("--add-dir");
                command.add(dir);
            }
        }

        if (sessionId != null && !sessionId.isEmpty()) {
            command.add("--resume");
            command.add(sessionId);
        }

        command.add("--");
        command.add(message);

        return command;
    }

    /**
     * 将附件数据写入临时文件。
     */
    private File writeAttachmentToTempFile(ClaudeSession.Attachment attachment, String channelId) {
        try {
            if (attachment.localPath != null && !attachment.localPath.isBlank()) {
                File persisted = new File(attachment.localPath);
                if (persisted.isFile()) {
                    return persisted;
                }
            }
            String suffix = getFileSuffix(attachment.fileName);
            File tempDir = processManager.prepareClaudeTempDir();
            String prefix = "cli-att-" + (channelId != null ? channelId.hashCode() : System.currentTimeMillis());
            File tempFile = File.createTempFile(prefix, suffix, tempDir);
            byte[] data = Base64.getDecoder().decode(attachment.data);
            try (FileOutputStream fos = new FileOutputStream(tempFile)) {
                fos.write(data);
            }
            LOG.debug("[CliBridge] 附件写入临时文件: " + tempFile.getAbsolutePath());
            return tempFile;
        } catch (Exception e) {
            LOG.warn("[CliBridge] 写入附件临时文件失败: " + e.getMessage());
            return null;
        }
    }

    private boolean isImageAttachment(ClaudeSession.Attachment attachment) {
        if (attachment.mediaType != null && attachment.mediaType.startsWith("image/")) {
            return true;
        }
        if (attachment.fileName != null) {
            String lower = attachment.fileName.toLowerCase();
            return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                    || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".bmp");
        }
        return false;
    }

    private String getFileSuffix(String fileName) {
        if (fileName == null || !fileName.contains(".")) {
            return ".tmp";
        }
        return fileName.substring(fileName.lastIndexOf("."));
    }

    private void cleanupTempFiles(List<File> tempFiles) {
        File allowedTempDirFile = processManager.prepareClaudeTempDir();
        Path allowedTempDir = allowedTempDirFile != null
                ? allowedTempDirFile.toPath().toAbsolutePath().normalize()
                : null;
        for (File f : tempFiles) {
            try {
                if (f == null || !f.exists() || allowedTempDir == null) {
                    continue;
                }
                Path filePath = f.toPath().toAbsolutePath().normalize();
                if (filePath.startsWith(allowedTempDir)) {
                    f.delete();
                }
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * 检查 CLI 环境是否可用。
     */
    boolean checkEnvironment() {
        return cliDetector.findCliExecutable() != null;
    }
}
