package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
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
 * opencode SDK bridge.
 *
 * The provider is registered now so routing and dependency management can treat
 * opencode as a peer provider. The Node bridge currently returns an explicit
 * not-implemented error until the HTTP session/event implementation lands.
 */
public class OpenCodeSDKBridge extends BaseSDKBridge {

    public OpenCodeSDKBridge() {
        super(OpenCodeSDKBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "opencode";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("OPENCODE_USE_STDIN", "true");
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
            LOG.debug("[opencode] " + line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
        } else if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        } else if (line.startsWith("[THREAD_ID]")) {
            String receivedSessionId = line.substring("[THREAD_ID]".length()).trim();
            callback.onMessage("session_id", receivedSessionId);
        } else if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    result.messages.add(msg);
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "unknown";
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
        } else if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj != null && obj.has("error")) {
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

    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agent,
            MessageCallback callback
    ) {
        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("message", message != null ? message : "");
        stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
        stdinInput.addProperty("cwd", cwd != null ? cwd : "");
        stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        stdinInput.addProperty("model", model != null ? model : "");
        stdinInput.addProperty("agent", agent != null ? agent : "");
        stdinInput.add("attachments", buildAttachments(attachments));

        return executeStreamingCommand(
                channelId,
                buildBaseCommand("send"),
                gson.toJson(stdinInput),
                cwd,
                callback
        );
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return Collections.emptyList();
    }

    private JsonArray buildAttachments(List<ClaudeSession.Attachment> attachments) {
        JsonArray attachmentsArray = new JsonArray();
        if (attachments == null || attachments.isEmpty()) {
            return attachmentsArray;
        }

        for (ClaudeSession.Attachment attachment : attachments) {
            if (attachment == null) {
                continue;
            }
            JsonObject obj = new JsonObject();
            obj.addProperty("fileName", attachment.fileName != null ? attachment.fileName : "");
            obj.addProperty("mediaType", attachment.mediaType != null ? attachment.mediaType : "");
            obj.addProperty("data", attachment.data != null ? attachment.data : "");
            attachmentsArray.add(obj);
        }
        return attachmentsArray;
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to decode JSON string payload, falling back to raw: " + e.getMessage());
            return jsonStr;
        }
    }
}
