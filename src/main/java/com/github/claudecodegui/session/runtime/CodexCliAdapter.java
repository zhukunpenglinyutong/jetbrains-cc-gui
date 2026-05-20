package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Direct Codex CLI adapter using `codex exec --json`.
 */
public class CodexCliAdapter implements CliAdapter {
    private static final Logger LOG = Logger.getInstance(CodexCliAdapter.class);
    private static final String TEMP_DIR_NAME = "codex-runtime-images";
    private static final Set<String> PROTECTED_ENV_KEYS = Set.of(
            "CODEX_USE_STDIN",
            "CODEX_MODEL",
            "CODEX_SANDBOX_MODE",
            "CODEX_SANDBOX",
            "CODEX_APPROVAL_POLICY",
            "CODEX_CI",
            "CODEX_SANDBOX_NETWORK_DISABLED",
            "CODEX_HOME",
            "CLAUDE_SESSION_ID",
            "CLAUDE_PERMISSION_DIR",
            "HOME",
            "PATH",
            "TMPDIR",
            "TEMP",
            "TMP",
            "IDEA_PROJECT_PATH",
            "PROJECT_PATH",
            "CLAUDE_USE_STDIN"
    );

    private final ProcessManager processManager;
    private final CodexSDKBridge sdkBridge;
    private final Gson gson;

    public CodexCliAdapter(ProcessManager processManager, CodexSDKBridge sdkBridge) {
        this(processManager, sdkBridge, new Gson());
    }

    CodexCliAdapter(ProcessManager processManager, CodexSDKBridge sdkBridge, Gson gson) {
        this.processManager = processManager;
        this.sdkBridge = sdkBridge;
        this.gson = gson;
    }

    @Override
    public CompletableFuture<SDKResult> send(CliRequest request, MessageCallback callback) {
        return CompletableFuture.supplyAsync(() -> runCodexExec(request, callback));
    }

    @Override
    public JsonObject launch(RuntimeKey key, String sessionId, String cwd) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("channelId", key.channelId());
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        result.addProperty("message", "Codex CLI runtime ready");
        return result;
    }

    @Override
    public void interrupt(RuntimeKey key) {
        processManager.interruptRuntime(key);
    }

    @Override
    public List<JsonObject> loadMessages(String sessionId, String cwd) {
        return sdkBridge.getSessionMessages(sessionId, cwd);
    }

    static PermissionSelection selectPermission(String permissionMode, String configuredSandbox) {
        String sandbox = normalizeSandbox(configuredSandbox);
        String approval;
        if ("bypassPermissions".equals(permissionMode)) {
            approval = "never";
            sandbox = "danger-full-access";
        } else if ("acceptEdits".equals(permissionMode) || "autoEdit".equals(permissionMode)) {
            approval = "on-request";
        } else {
            approval = "untrusted";
        }
        return new PermissionSelection(approval, sandbox);
    }

    static Map<String, String> sanitizeEnv(Map<String, String> env) {
        Map<String, String> result = new LinkedHashMap<>();
        if (env == null) {
            return result;
        }
        for (Map.Entry<String, String> entry : env.entrySet()) {
            String key = entry.getKey();
            if (key == null || key.trim().isEmpty()) {
                continue;
            }
            if (PROTECTED_ENV_KEYS.contains(key.toUpperCase(Locale.ROOT))) {
                continue;
            }
            result.put(key, entry.getValue());
        }
        return result;
    }

    private SDKResult runCodexExec(CliRequest request, MessageCallback callback) {
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        List<File> tempFiles = new ArrayList<>();
        Process process = null;

        try {
            callback.onQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState.PROCESSING, 0);
            callback.onMessage("stream_start", "");
            callback.onMessage("message_start", "");

            List<File> images = prepareImageFiles(request.attachments(), tempFiles);
            List<String> command = buildCommand(request, images);
            ProcessBuilder pb = new ProcessBuilder(command);
            pb.redirectErrorStream(true);
            if (request.cwd() != null && !request.cwd().isBlank()) {
                File cwd = new File(request.cwd());
                if (cwd.isDirectory()) {
                    pb.directory(cwd);
                }
            }
            pb.environment().put("NO_COLOR", "1");
            pb.environment().putAll(sanitizeEnv(request.env()));

            LOG.info("[CodexCliAdapter] Command: " + String.join(" ", command));
            process = pb.start();
            processManager.registerProcess(request.key(), process);

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    parseOutputLine(line, callback, result, assistantContent);
                }
            }

            process.waitFor();
            int exitCode = process.exitValue();
            boolean interrupted = processManager.wasInterrupted(request.key());

            result.finalResult = assistantContent.toString();
            result.messageCount = result.messages.size();

            if (interrupted) {
                result.success = false;
                result.error = "User interrupted";
                callback.onQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState.NONE, 0);
                callback.onComplete(result);
                return result;
            }

            if (exitCode == 0) {
                result.success = true;
                callback.onMessage("stream_end", "");
                callback.onMessage("message_end", "");
                callback.onComplete(result);
            } else {
                result.success = false;
                result.error = "Codex CLI exited with code: " + exitCode;
                callback.onQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState.NONE, 0);
                callback.onError(result.error);
            }
            return result;
        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
            LOG.warn("[CodexCliAdapter] Execution failed: " + e.getMessage(), e);
            callback.onQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState.NONE, 0);
            callback.onError(result.error);
            return result;
        } finally {
            if (process != null) {
                processManager.unregisterProcess(request.key(), process);
                processManager.waitForProcessTermination(process);
            }
            cleanupTempFiles(tempFiles);
        }
    }

    private List<String> buildCommand(CliRequest request, List<File> images) {
        PermissionSelection permission = selectPermission(request.permissionMode(), readSandboxMode(request.cwd()));
        List<String> command = new ArrayList<>();
        addCodexExecutable(command, CodexCliResolver.findExecutable());
        addCodexGlobalOptions(command, permission);
        command.add("exec");
        command.add("--json");
        command.add("--color");
        command.add("never");
        command.add("--sandbox");
        command.add(permission.sandbox());
        if (request.cwd() != null && !request.cwd().isBlank()) {
            command.add("-C");
            command.add(request.cwd());
        }
        if (request.model() != null && !request.model().isBlank()) {
            command.add("-m");
            command.add(request.model());
        }
        if (request.reasoningEffort() != null && !request.reasoningEffort().isBlank()) {
            command.add("-c");
            command.add("model_reasoning_effort=\"" + request.reasoningEffort() + "\"");
        }
        for (File image : images) {
            command.add("--image");
            command.add(image.getAbsolutePath());
        }
        command.add(buildPrompt(request));
        return command;
    }

    static void addCodexExecutable(List<String> command, String executable) {
        String resolved = executable != null && !executable.isBlank() ? executable : "codex";
        String lower = resolved.toLowerCase(Locale.ROOT);
        if (PlatformUtils.isWindows() && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
            command.add("cmd");
            command.add("/c");
            command.add(resolved);
            return;
        }
        command.add(resolved);
    }

    static void addCodexGlobalOptions(List<String> command, PermissionSelection permission) {
        command.add("--ask-for-approval");
        command.add(permission.approval());
    }

    private String buildPrompt(CliRequest request) {
        StringBuilder prompt = new StringBuilder(request.message() != null ? request.message() : "");
        if (request.openedFiles() != null && request.openedFiles().size() > 0) {
            prompt.append("\n\n## Opened Files Context\n\n").append(gson.toJson(request.openedFiles()));
        }
        if (!request.fileTagPaths().isEmpty()) {
            prompt.append("\n\n## Referenced Files\n\n");
            for (String path : request.fileTagPaths()) {
                prompt.append("- ").append(path).append('\n');
            }
        }
        if (request.agentPrompt() != null && !request.agentPrompt().isBlank()) {
            prompt.append("\n\n## Agent Role and Instructions\n\n").append(request.agentPrompt());
        }
        return prompt.toString();
    }

    private void parseOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent
    ) {
        if (line == null || line.isBlank()) {
            return;
        }
        try {
            JsonObject event = gson.fromJson(line, JsonObject.class);
            if (event == null) {
                return;
            }
            handleJsonEvent(event, callback, result, assistantContent);
        } catch (Exception e) {
            assistantContent.append(line).append('\n');
            callback.onMessage("content_delta", line + "\n");
        }
    }

    private void handleJsonEvent(
            JsonObject event,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent
    ) {
        String type = readString(event, "type");
        if ("thread_id".equals(type) || "session_id".equals(type)) {
            String id = readString(event, "thread_id");
            if (id == null) {
                id = readString(event, "session_id");
            }
            if (id != null) {
                callback.onMessage("session_id", id);
            }
            return;
        }

        String text = extractText(event);
        if (text != null && !text.isEmpty()) {
            assistantContent.append(text);
            callback.onMessage("content_delta", text);
        }

        JsonObject assistant = normalizeAssistantMessage(event);
        if (assistant != null) {
            result.messages.add(assistant);
            callback.onMessage("assistant", assistant.toString());
        }

        JsonObject usage = extractUsage(event);
        if (usage != null) {
            callback.onMessage("usage", usage.toString());
        }

        if ("task_complete".equals(type) || "agent_message".equals(type) || "exec_completed".equals(type)) {
            callback.onMessage("message_end", "");
        } else if ("error".equals(type)) {
            String message = readString(event, "message");
            if (message == null) {
                message = event.toString();
            }
            callback.onError(message);
        }
    }

    private JsonObject normalizeAssistantMessage(JsonObject event) {
        if (!"assistant_message".equals(readString(event, "type"))
                && !"agent_message".equals(readString(event, "type"))) {
            return null;
        }
        String text = extractText(event);
        if (text == null || text.isEmpty()) {
            return null;
        }
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

    private JsonObject extractUsage(JsonObject event) {
        if (event.has("usage") && event.get("usage").isJsonObject()) {
            return event.getAsJsonObject("usage");
        }
        if (event.has("info") && event.get("info").isJsonObject()) {
            JsonObject info = event.getAsJsonObject("info");
            if (info.has("total_token_usage") && info.get("total_token_usage").isJsonObject()) {
                return info.getAsJsonObject("total_token_usage");
            }
        }
        return null;
    }

    private String extractText(JsonObject event) {
        String text = readString(event, "delta");
        if (text == null) {
            text = readString(event, "text");
        }
        if (text == null) {
            text = readString(event, "message");
        }
        return text;
    }

    private String readString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        JsonElement value = object.get(key);
        return value.isJsonPrimitive() ? value.getAsString() : value.toString();
    }

    private List<File> prepareImageFiles(List<ClaudeSession.Attachment> attachments, List<File> tempFiles) throws Exception {
        List<File> files = new ArrayList<>();
        if (attachments == null || attachments.isEmpty()) {
            return files;
        }
        File tempDir = new File(System.getProperty("java.io.tmpdir"), TEMP_DIR_NAME);
        if (!tempDir.exists() && !tempDir.mkdirs()) {
            throw new IllegalStateException("Failed to create Codex temp dir: " + tempDir.getAbsolutePath());
        }
        for (ClaudeSession.Attachment attachment : attachments) {
            if (attachment == null || !isImageAttachment(attachment)) {
                continue;
            }
            File file = resolveAttachmentFile(attachment, tempDir, tempFiles);
            if (file == null || !file.isFile()) {
                throw new IllegalArgumentException("Attachment file is missing: "
                        + (attachment.localPath != null ? attachment.localPath : attachment.fileName));
            }
            files.add(file);
        }
        return files;
    }

    private File resolveAttachmentFile(ClaudeSession.Attachment attachment, File tempDir, List<File> tempFiles) throws Exception {
        if (attachment.localPath != null && !attachment.localPath.isBlank()) {
            return new File(attachment.localPath);
        }
        if (attachment.data == null || attachment.data.isBlank()) {
            return null;
        }
        File tempFile = File.createTempFile("codex-img-", getImageExtension(attachment.mediaType), tempDir);
        byte[] data = Base64.getDecoder().decode(attachment.data);
        try (FileOutputStream fos = new FileOutputStream(tempFile)) {
            fos.write(data);
        }
        tempFiles.add(tempFile);
        return tempFile;
    }

    private boolean isImageAttachment(ClaudeSession.Attachment attachment) {
        if (attachment.mediaType != null && attachment.mediaType.startsWith("image/")) {
            return true;
        }
        if (attachment.fileName == null) {
            return false;
        }
        String lower = attachment.fileName.toLowerCase(Locale.ROOT);
        return lower.endsWith(".png")
                || lower.endsWith(".jpg")
                || lower.endsWith(".jpeg")
                || lower.endsWith(".gif")
                || lower.endsWith(".webp")
                || lower.endsWith(".bmp");
    }

    private String getImageExtension(String mimeType) {
        if ("image/jpeg".equalsIgnoreCase(mimeType) || "image/jpg".equalsIgnoreCase(mimeType)) {
            return ".jpg";
        }
        if ("image/gif".equalsIgnoreCase(mimeType)) {
            return ".gif";
        }
        if ("image/webp".equalsIgnoreCase(mimeType)) {
            return ".webp";
        }
        if ("image/bmp".equalsIgnoreCase(mimeType)) {
            return ".bmp";
        }
        return ".png";
    }

    private void cleanupTempFiles(List<File> tempFiles) {
        for (File file : tempFiles) {
            try {
                if (file != null && file.exists()) {
                    file.delete();
                }
            } catch (Exception ignored) {
            }
        }
    }

    private String readSandboxMode(String cwd) {
        String fallback = PlatformUtils.isWindows() ? "danger-full-access" : "workspace-write";
        try {
            String configured = new CodemossSettingsService().getCodexSandboxMode(cwd);
            return normalizeSandbox(configured);
        } catch (Exception e) {
            LOG.debug("[CodexCliAdapter] Failed to read sandbox mode: " + e.getMessage());
            return fallback;
        }
    }

    private static String normalizeSandbox(String sandbox) {
        if ("read-only".equals(sandbox)
                || "workspace-write".equals(sandbox)
                || "danger-full-access".equals(sandbox)) {
            return sandbox;
        }
        return PlatformUtils.isWindows() ? "danger-full-access" : "workspace-write";
    }

    record PermissionSelection(String approval, String sandbox) {
    }
}
