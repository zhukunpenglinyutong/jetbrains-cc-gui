package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Shared bridge for headless CLI providers that speak the marker protocol
 * (Grok / Kimi / OpenCode).
 *
 * <p>Subclasses only supply provider id, stdin env flag, and optional history.
 */
public abstract class MarkerCliBridge extends BaseSDKBridge {

    protected MarkerCliBridge(Class<?> loggerClass) {
        super(loggerClass);
    }

    /** Public provider id for routing maps (e.g. {@code grok}, {@code kimi}). */
    public final String providerId() {
        return getProviderName();
    }

    /**
     * Env var that enables JSON stdin for channel-manager (e.g. GROK_USE_STDIN).
     */
    protected abstract String getStdinEnvKey();

    /**
     * Optional extra env vars (disable auto-updater, etc.).
     */
    protected void configureExtraEnv(Map<String, String> env) {
        // default: none
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put(getStdinEnvKey(), "true");
        configureExtraEnv(env);
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        if (line.contains("[DEBUG]")) {
            LOG.debug("[" + getProviderName() + "] " + line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
        } else if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        } else if (line.startsWith("[SESSION_ID]")) {
            String sessionId = line.substring("[SESSION_ID]".length()).trim();
            callback.onMessage("session_id", sessionId);
        } else if (line.startsWith("[USAGE]")) {
            String usageJson = line.substring("[USAGE]".length()).trim();
            callback.onMessage("usage", usageJson);
        } else if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "unknown";
                    result.messages.add(msg);
                    callback.onMessage(msgType, jsonStr);
                }
            } catch (Exception ignored) {
            }
        } else if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        } else if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
        } else if (line.startsWith("[CONTENT]")) {
            // Payload is raw content: strip only the single separator space (as
            // decodeJsonStringPayload does); trimming would corrupt meaningful
            // leading/trailing whitespace.
            String rawPayload = line.substring("[CONTENT]".length());
            String content = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
            // If deltas were already streamed, assistantContent holds the full
            // text and this final emission is a duplicate — don't append again.
            if (assistantContent.length() == 0) {
                assistantContent.append(content);
            }
            callback.onMessage("content", content);
        } else if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj != null && obj.has("error") && !obj.get("error").isJsonNull()) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
        }
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            LOG.warn("[" + getProviderName() + "] Failed to decode JSON string payload, falling back to raw: "
                    + e.getMessage());
            return jsonStr;
        }
    }

    /**
     * Load session messages for history restore. Default: empty (override per provider).
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return Collections.emptyList();
    }

    /**
     * Send a message through the CLI provider (streaming markers).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            String model,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, cwd, model, reasoningEffort,
                null, null, null, callback);
    }

    /**
     * Send a message with optional image attachments.
     *
     * <p>Attachments are base64 payloads from the UI (fileName/mediaType/data).
     * Each CLI provider materialises them appropriately (Grok ACP image blocks,
     * OpenCode {@code -f}, Kimi ReadMediaFile path injection, etc.).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            String model,
            String reasoningEffort,
            List<ClaudeSession.Attachment> attachments,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, cwd, model, reasoningEffort,
                attachments, null, null, callback);
    }

    /**
     * Send a message with optional attachments and permission mode.
     *
     * <p>{@code permissionMode} is required for Grok ACP auto-approve
     * ({@code bypassPermissions} / full-auto). Without it the Node side
     * defaults to {@code default} and every tool/edit still pops the dialog.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            String model,
            String reasoningEffort,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String dshPreset,
            MessageCallback callback
    ) {
        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("message", message != null ? message : "");
        stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
        stdinInput.addProperty("cwd", cwd != null ? cwd : "");
        stdinInput.addProperty("model", model != null ? model : "");
        stdinInput.addProperty("reasoningEffort", reasoningEffort != null ? reasoningEffort : "");
        // Always send permissionMode (even "default") so Grok/other CLIs never
        // fall back to an implicit default that ignores the UI mode selection.
        String mode = permissionMode != null && !permissionMode.isBlank() ? permissionMode.trim() : "default";
        stdinInput.addProperty("permissionMode", mode);
        if (dshPreset != null) {
            stdinInput.addProperty("preset", dshPreset);
        }
        if (attachments != null && !attachments.isEmpty()) {
            stdinInput.add("attachments", buildAttachmentArray(attachments));
        }

        String stdinJson = gson.toJson(stdinInput);
        List<String> command = buildBaseCommand("send");
        if (command.isEmpty()) {
            SDKResult error = new SDKResult();
            error.success = false;
            error.error = "Bridge directory not ready or invalid";
            callback.onError(error.error);
            return CompletableFuture.completedFuture(error);
        }

        int attachmentCount = attachments != null ? attachments.size() : 0;
        LOG.info("[" + getProviderName() + "] send sessionId="
                + (sessionId != null && !sessionId.isEmpty() ? sessionId : "(new)")
                + " model=" + (model != null && !model.isEmpty() ? model : "(default)")
                + " permissionMode=" + mode
                + " attachments=" + attachmentCount);

        return executeStreamingCommand(channelId, command, stdinJson, cwd, callback);
    }

    private JsonArray buildAttachmentArray(List<ClaudeSession.Attachment> attachments) {
        JsonArray attArr = new JsonArray();
        for (ClaudeSession.Attachment attachment : attachments) {
            if (attachment == null) {
                continue;
            }
            JsonObject o = new JsonObject();
            o.addProperty("fileName", attachment.fileName != null ? attachment.fileName : "");
            o.addProperty("mediaType", attachment.mediaType != null ? attachment.mediaType : "");
            o.addProperty("data", attachment.data != null ? attachment.data : "");
            attArr.add(o);
        }
        return attArr;
    }
}
