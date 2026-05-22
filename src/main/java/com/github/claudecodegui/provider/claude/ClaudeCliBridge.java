package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.cli.common.CliErrorFormatter;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.runtime.RuntimeKey;
import com.github.claudecodegui.settings.CodemossSettingsService;
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
public class ClaudeCliBridge {

    private static final Logger LOG = Logger.getInstance(ClaudeCliBridge.class);
    private static final int CLI_DIAGNOSTIC_MAX_CHARS = 4000;

    private final ProcessManager processManager;
    private final ClaudeCliDetector cliDetector;
    private final Gson gson;
    private final EnvironmentConfigurator envConfigurator;

    public ClaudeCliBridge(
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

    public CompletableFuture<SDKResult> sendMessage(
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
        return sendMessage(null, channelId, message, sessionId, runtimeSessionEpoch, cwd,
                attachments, permissionMode, model, openedFiles, agentPrompt,
                streaming, disableThinking, reasoningEffort, callback);
    }

    public CompletableFuture<SDKResult> sendMessage(
            RuntimeKey runtimeKey,
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
            StringBuilder cliDiagnostic = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            long startTime = System.currentTimeMillis();
            Process process = null;
            ClaudeCliStreamParser streamParser = new ClaudeCliStreamParser(gson);
            List<File> tempFiles = new ArrayList<>();
            boolean suppressThinking = false;

            // PR #1191 review M1: keep entry log at info but never include prompt body / attachment data.
            LOG.info("[CliBridge] sendMessage entry, attachments="
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

                String fullPrompt = enrichPromptWithContext(message, openedFiles, agentPrompt);
                if (attachments != null && !attachments.isEmpty()) {
                    LOG.debug("[CliBridge] Processing " + attachments.size() + " attachments");
                    List<ClaudeCliAttachmentPrompt.ResolvedAttachment> resolvedAttachments = new ArrayList<>();
                    for (int i = 0; i < attachments.size(); i++) {
                        ClaudeSession.Attachment attachment = attachments.get(i);
                        if (attachment == null) {
                            continue;
                        }

                        LOG.debug("[CliBridge] Attachment[" + i + "]: fileName=" + attachment.fileName
                                + ", mediaType=" + attachment.mediaType
                                + ", localPath=" + attachment.localPath
                                + ", data=" + (attachment.data != null ? attachment.data.length() + "chars" : "null")
                                + ", isImage=" + isImageAttachment(attachment));

                        File tempFile = writeAttachmentToTempFile(attachment, channelId);
                        LOG.debug("[CliBridge] writeAttachmentToTempFile returned: "
                                + (tempFile != null ? tempFile.getAbsolutePath() : "NULL"));
                        if (tempFile == null) {
                            continue;
                        }

                        // Only track for cleanup if this is a temp file, not a persisted attachment
                        if (attachment.localPath == null
                                || !tempFile.getAbsolutePath().equals(attachment.localPath)) {
                            tempFiles.add(tempFile);
                        }
                        resolvedAttachments.add(new ClaudeCliAttachmentPrompt.ResolvedAttachment(
                                i + 1,
                                attachment,
                                tempFile
                        ));
                    }
                    ClaudeCliAttachmentPrompt.Rendered rendered =
                            ClaudeCliAttachmentPrompt.render(fullPrompt, resolvedAttachments);
                    fullPrompt = rendered.prompt();
                    List<String> addDirs = rendered.addDirs();
                    List<String> command = buildCliCommand(cliPath, fullPrompt, sessionId, model,
                            reasoningEffort, permissionMode, addDirs);
                    LOG.debug("[CliBridge] fullPrompt length=" + fullPrompt.length() + ", addDirs=" + addDirs);
                    LOG.debug("[CliBridge] fullPrompt content: "
                            + (fullPrompt.length() > 500 ? fullPrompt.substring(0, 500) + "..." : fullPrompt));
                    if (Boolean.TRUE.equals(disableThinking)) {
                        LOG.info("[CliBridge] disableThinking requested, but Claude CLI output will keep thinking events to preserve CLI/SDK parity");
                    }
                    LOG.debug("[CliBridge] Command: " + String.join(" ", command));

                    process = startProcess(
                            command,
                            cwd,
                            envConfigurator,
                            runtimeKey,
                            channelId
                    );
                } else {
                    List<String> command = buildCliCommand(cliPath, fullPrompt, sessionId, model,
                            reasoningEffort, permissionMode, List.of());
                    LOG.debug("[CliBridge] fullPrompt length=" + fullPrompt.length() + ", addDirs=[]");
                    LOG.debug("[CliBridge] fullPrompt content: "
                            + (fullPrompt.length() > 500 ? fullPrompt.substring(0, 500) + "..." : fullPrompt));
                    if (Boolean.TRUE.equals(disableThinking)) {
                        LOG.info("[CliBridge] disableThinking requested, but Claude CLI output will keep thinking events to preserve CLI/SDK parity");
                    }
                    LOG.debug("[CliBridge] Command: " + String.join(" ", command));

                    process = startProcess(
                            command,
                            cwd,
                            envConfigurator,
                            runtimeKey,
                            channelId
                    );
                }
                streamParser.resetState();

                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (line.trim().isEmpty()) {
                            continue;
                        }
                        appendCliDiagnosticLine(cliDiagnostic, line);
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
                boolean wasInterrupted = runtimeKey != null
                        ? processManager.wasInterrupted(runtimeKey)
                        : processManager.wasInterrupted(channelId);
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
                        // Don't override COMPLETED status - ClaudeMessageHandler.handleStreamEnd()
                        // already set it to COMPLETED when stream_end was received
                        callback.onComplete(result);
                    } else {
                        String errorMsg = buildCliExitError(exitCode, cliDiagnostic);
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
                result.error = CliErrorFormatter.formatError("Claude", e.getMessage());
                errorAlreadyReported.set(true);
                LOG.error("[CliBridge] Execution failed", e);
                callback.onQueueDisplayStateChanged(QueueDisplayState.NONE, 0);
                callback.onError(result.error);
                return result;
            } finally {
                cleanupTempFiles(tempFiles);
                // Don't override COMPLETED status in finally block - only set to NONE on error
                // The success case is handled above where onComplete preserves COMPLETED state
                if (process != null) {
                    if (runtimeKey != null) {
                        processManager.unregisterProcess(runtimeKey, process);
                    } else {
                        processManager.unregisterProcess(channelId, process);
                    }
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

    /**
     * Applies the user-selected permission mode to the CLI command.
     * Safety contract:
     *   - "bypassPermissions"            -> --dangerously-skip-permissions (explicit opt-in only)
     *   - "default"/"acceptEdits"/"plan" -> --permission-mode &lt;mode&gt;
     *   - null / blank / unknown         -> defaults to "acceptEdits" (auto-accept file edits,
     *                                       still prompts for shell commands), NEVER full bypass.
     * This avoids silently running every CLI request with full bypass when callers forget to
     * thread a permissionMode through (see PR #1191 review C1).
     */
    public static void applyPermissionMode(List<String> command, String permissionMode) {
        if ("bypassPermissions".equals(permissionMode)) {
            command.add("--dangerously-skip-permissions");
            return;
        }
        String mode = permissionMode;
        if (mode == null || mode.isBlank()) {
            mode = "acceptEdits";
        } else if (!"default".equals(mode) && !"acceptEdits".equals(mode) && !"plan".equals(mode)) {
            // Unknown value -> fall back to safe default rather than echoing it raw to the CLI.
            mode = "acceptEdits";
        }
        command.add("--permission-mode");
        command.add(mode);
    }

    static void appendCliDiagnosticLine(StringBuilder diagnostic, String line) {
        CliErrorFormatter.appendDiagnosticLine(diagnostic, line, CLI_DIAGNOSTIC_MAX_CHARS);
    }

    static String buildCliExitError(int exitCode, StringBuilder diagnostic) {
        return CliErrorFormatter.formatExitError("Claude", exitCode, diagnostic);
    }

    String enrichPromptWithContext(String message, JsonObject openedFiles, String agentPrompt) {
        StringBuilder prompt = new StringBuilder(message != null ? message : "");
        if (openedFiles != null && openedFiles.size() > 0) {
            prompt.append("\n\n## Opened Files Context\n\n").append(gson.toJson(openedFiles));
        }
        if (agentPrompt != null && !agentPrompt.isBlank()) {
            prompt.append("\n\n## Agent Role and Instructions\n\n").append(agentPrompt);
        }
        return prompt.toString();
    }

    private List<String> buildCliCommand(
            String cliPath,
            String message,
            String sessionId,
            String model,
            String reasoningEffort,
            String permissionMode,
            List<String> addDirs
    ) {
        List<String> command = new ArrayList<>();
        command.add(cliPath);
        command.add("-p");
        command.add("--output-format");
        command.add("stream-json");
        command.add("--verbose");
        command.add("--include-partial-messages");
        applyPermissionMode(command, permissionMode);

        String cliModel = resolveCliModel(model);
        if (cliModel != null && !cliModel.isEmpty()) {
            command.add("--model");
            command.add(cliModel);
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

    private Process startProcess(
            List<String> command,
            String cwd,
            EnvironmentConfigurator configurator,
            RuntimeKey runtimeKey,
            String channelId
    ) throws Exception {
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
        configurator.configureProjectPath(env, cwd);
        configurator.configurePermissionEnv(env);

        Process process = processBuilder.start();
        LOG.info("[CliBridge] CLI process started, pid=" + process.pid());
        if (runtimeKey != null) {
            processManager.registerProcess(runtimeKey, process);
        } else {
            processManager.registerProcess(channelId, process);
        }
        return process;
    }

    private String resolveCliModel(String selectedModel) {
        try {
            JsonObject claudeSettings = new CodemossSettingsService().readClaudeSettings();
            if (claudeSettings == null || !claudeSettings.has("env") || !claudeSettings.get("env").isJsonObject()) {
                return selectedModel;
            }
            String resolved = resolveMappedClaudeModel(selectedModel, claudeSettings.getAsJsonObject("env"));
            if (resolved != null && !resolved.equals(selectedModel)) {
                LOG.info("[CliBridge] Resolved CLI model mapping: " + selectedModel + " -> " + resolved);
            }
            return resolved;
        } catch (Exception e) {
            LOG.warn("[CliBridge] Failed to resolve CLI model mapping: " + e.getMessage());
            return selectedModel;
        }
    }

    static String resolveMappedClaudeModel(String selectedModel, JsonObject env) {
        if (selectedModel == null || selectedModel.isBlank() || env == null) {
            return selectedModel;
        }

        String mainModel = readEnvValue(env, "ANTHROPIC_MODEL");
        if (mainModel != null) {
            return mainModel;
        }

        String normalized = selectedModel.replaceFirst("(?i)\\[1m\\]$", "").toLowerCase();
        if (!normalized.startsWith("claude-") && !normalized.startsWith("claude_")) {
            return selectedModel;
        }

        if (normalized.contains("opus")) {
            String mappedOpus = readEnvValue(env, "ANTHROPIC_DEFAULT_OPUS_MODEL");
            return mappedOpus != null ? mappedOpus : selectedModel;
        }
        if (normalized.contains("haiku")) {
            String mappedHaiku = readEnvValue(env, "ANTHROPIC_SMALL_FAST_MODEL");
            if (mappedHaiku == null) {
                mappedHaiku = readEnvValue(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL");
            }
            return mappedHaiku != null ? mappedHaiku : selectedModel;
        }
        if (normalized.contains("sonnet")) {
            String mappedSonnet = readEnvValue(env, "ANTHROPIC_DEFAULT_SONNET_MODEL");
            return mappedSonnet != null ? mappedSonnet : selectedModel;
        }

        return selectedModel;
    }

    private static String readEnvValue(JsonObject env, String key) {
        if (env == null || key == null || !env.has(key) || env.get(key).isJsonNull()) {
            return null;
        }
        String value = env.get(key).getAsString();
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
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
