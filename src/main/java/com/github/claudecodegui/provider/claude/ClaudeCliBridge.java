package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.ClaudeSession.SessionCallback.QueueDisplayState;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Invokes Claude CLI directly as an OS child process.
 */
class ClaudeCliBridge {

    private static final Logger LOG = Logger.getInstance(ClaudeCliBridge.class);

    private final ProcessManager processManager;
    private final ClaudeCliDetector cliDetector;
    private final Gson gson;
    private final EnvironmentConfigurator envConfigurator;

    ClaudeCliBridge(
            ProcessManager processManager,
            ClaudeCliDetector cliDetector,
            Gson gson,
            EnvironmentConfigurator envConfigurator
    ) {
        this.processManager = processManager;
        this.cliDetector = cliDetector;
        this.gson = gson;
        this.envConfigurator = envConfigurator;
    }

    CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
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
            Process process = null;
            ClaudeCliStreamParser streamParser = new ClaudeCliStreamParser(gson);
            List<File> tempFiles = new ArrayList<>();
            boolean suppressThinking = Boolean.TRUE.equals(disableThinking);

            LOG.info("[CliBridge][DIAG] sendMessage entry, attachments="
                    + (attachments == null ? "NULL" : attachments.size())
                    + ", message length=" + (message != null ? message.length() : 0)
                    + ", runtimeSessionEpoch=" + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)"));

            try {
                callback.onQueueDisplayStateChanged(QueueDisplayState.PROCESSING, 0);

                String cliPath = cliDetector.findCliExecutable();
                if (cliPath == null) {
                    String error = "Unable to find Claude CLI executable. Install Claude Code or configure claudeCliPath.";
                    result.success = false;
                    result.error = error;
                    callback.onError(error);
                    return result;
                }

                String fullPrompt = message != null ? message : "";
                List<String> addDirs = new ArrayList<>();
                if (attachments != null && !attachments.isEmpty()) {
                    LOG.info("[CliBridge][DIAG] Processing " + attachments.size() + " attachments");
                    StringBuilder promptBuilder = new StringBuilder(fullPrompt);
                    for (int i = 0; i < attachments.size(); i++) {
                        ClaudeSession.Attachment attachment = attachments.get(i);
                        if (attachment == null) {
                            continue;
                        }

                        LOG.info("[CliBridge][DIAG] Attachment[" + i + "]: fileName=" + attachment.fileName
                                + ", mediaType=" + attachment.mediaType
                                + ", localPath=" + attachment.localPath
                                + ", data=" + (attachment.data != null ? attachment.data.length() + "chars" : "null")
                                + ", isImage=" + isImageAttachment(attachment));

                        File tempFile = writeAttachmentToTempFile(attachment, channelId);
                        LOG.info("[CliBridge][DIAG] writeAttachmentToTempFile returned: "
                                + (tempFile != null ? tempFile.getAbsolutePath() : "NULL"));
                        if (tempFile == null) {
                            continue;
                        }

                        tempFiles.add(tempFile);
                        File parentDir = tempFile.getParentFile();
                        if (parentDir != null && parentDir.isDirectory()) {
                            String dirPath = parentDir.getAbsolutePath();
                            if (!addDirs.contains(dirPath)) {
                                addDirs.add(dirPath);
                            }
                        }

                        String safePath = tempFile.getAbsolutePath().replace('\\', '/');
                        if (isImageAttachment(attachment)) {
                            promptBuilder.append("\n\n[Attached image: ")
                                    .append(attachment.fileName)
                                    .append("]\nPlease use the Read tool to read the file at: ")
                                    .append(safePath)
                                    .append("\nThen answer the user's question about this image.");
                        } else {
                            promptBuilder.append("\n\n[Attached file: ")
                                    .append(attachment.fileName)
                                    .append("]\nPlease use the Read tool to read the file at: ")
                                    .append(safePath);
                        }
                    }
                    fullPrompt = promptBuilder.toString();
                }

                List<String> command = buildCliCommand(cliPath, fullPrompt, sessionId, model, reasoningEffort, addDirs);
                LOG.info("[CliBridge][DIAG] fullPrompt length=" + fullPrompt.length() + ", addDirs=" + addDirs);
                LOG.info("[CliBridge][DIAG] fullPrompt content: "
                        + (fullPrompt.length() > 500 ? fullPrompt.substring(0, 500) + "..." : fullPrompt));
                if (suppressThinking) {
                    LOG.info("[CliBridge] disableThinking requested; Claude CLI has no native no-thinking flag, suppressing thinking events in parser");
                }
                LOG.info("[CliBridge] Command: " + String.join(" ", command));

                ProcessBuilder processBuilder = new ProcessBuilder(command);
                processBuilder.redirectErrorStream(true);

                if (cwd != null && !cwd.isEmpty()) {
                    File workDir = new File(cwd);
                    if (workDir.exists()) {
                        processBuilder.directory(workDir);
                    }
                }

                Map<String, String> env = processBuilder.environment();
                env.put("NO_COLOR", "1");
                envConfigurator.configureProjectPath(env, cwd);
                envConfigurator.configurePermissionEnv(env);

                process = processBuilder.start();
                LOG.info("[CliBridge] CLI process started, pid=" + process.pid());
                processManager.registerProcess(channelId, process);
                streamParser.resetState();

                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (line.trim().isEmpty()) {
                            continue;
                        }
                        LOG.debug("[CliBridge] Received line: " + line);
                        streamParser.parseLine(
                                line,
                                callback,
                                result,
                                assistantContent,
                                hadSendError,
                                suppressThinking
                        );
                    }
                }

                process.waitFor();
                int exitCode = process.exitValue();
                boolean wasInterrupted = processManager.wasInterrupted(channelId);
                LOG.info("[CliBridge] Process exited, exitCode=" + exitCode + ", wasInterrupted=" + wasInterrupted);

                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();

                if (wasInterrupted) {
                    long elapsed = System.currentTimeMillis() - startTime;
                    LOG.info("[CliBridge] Request interrupted by user (elapsed: " + elapsed + "ms)");
                    result.error = "User interrupted";
                    callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
                    callback.onComplete(result);
                } else if (!hadSendError.get()) {
                    if (exitCode == 0) {
                        if (!result.success) {
                            result.success = true;
                        }
                        callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
                        callback.onComplete(result);
                    } else {
                        String errorMsg = "CLI process exited with code: " + exitCode;
                        result.success = false;
                        result.error = errorMsg;
                        callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
                        callback.onError(errorMsg);
                    }
                } else {
                    callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
                    callback.onComplete(result);
                }

                return result;
            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                errorAlreadyReported.set(true);
                LOG.error("[CliBridge] Execution failed", e);
                callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
                callback.onError(e.getMessage());
                return result;
            } finally {
                cleanupTempFiles(tempFiles);
                callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
                if (process != null) {
                    processManager.unregisterProcess(channelId, process);
                    processManager.waitForProcessTermination(process);
                }
            }
        }).exceptionally(ex -> {
            if (errorAlreadyReported.get()) {
                return new SDKResult();
            }
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage();
            callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

    private List<String> buildCliCommand(
            String cliPath,
            String message,
            String sessionId,
            String model,
            String reasoningEffort,
            List<String> addDirs
    ) {
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

    private File writeAttachmentToTempFile(ClaudeSession.Attachment attachment, String channelId) {
        try {
            if (attachment.localPath != null && !attachment.localPath.isBlank()) {
                File persisted = new File(attachment.localPath);
                if (persisted.isFile()) {
                    return persisted;
                }
            }

            if (attachment.data == null || attachment.data.isBlank()) {
                return null;
            }

            String suffix = getFileSuffix(attachment.fileName);
            File tempDir = processManager.prepareClaudeTempDir();
            if (tempDir == null) {
                return null;
            }

            String prefix = "cli-att-" + (channelId != null ? channelId.hashCode() : System.currentTimeMillis());
            File tempFile = File.createTempFile(prefix, suffix, tempDir);
            byte[] data = Base64.getDecoder().decode(attachment.data);
            try (FileOutputStream fos = new FileOutputStream(tempFile)) {
                fos.write(data);
            }
            LOG.debug("[CliBridge] Wrote attachment temp file: " + tempFile.getAbsolutePath());
            return tempFile;
        } catch (Exception e) {
            LOG.warn("[CliBridge] Failed to write attachment temp file: " + e.getMessage());
            return null;
        }
    }

    private boolean isImageAttachment(ClaudeSession.Attachment attachment) {
        if (attachment.mediaType != null && attachment.mediaType.startsWith("image/")) {
            return true;
        }
        if (attachment.fileName != null) {
            String lower = attachment.fileName.toLowerCase();
            return lower.endsWith(".png")
                    || lower.endsWith(".jpg")
                    || lower.endsWith(".jpeg")
                    || lower.endsWith(".gif")
                    || lower.endsWith(".webp")
                    || lower.endsWith(".bmp");
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
        for (File file : tempFiles) {
            try {
                if (file == null || !file.exists() || allowedTempDir == null) {
                    continue;
                }
                Path filePath = file.toPath().toAbsolutePath().normalize();
                if (filePath.startsWith(allowedTempDir)) {
                    file.delete();
                }
            } catch (Exception ignored) {
            }
        }
    }

    boolean checkEnvironment() {
        return cliDetector.findCliExecutable() != null;
    }
}
