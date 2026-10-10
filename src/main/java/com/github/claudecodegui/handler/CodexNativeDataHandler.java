package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

/** Routes native Codex history and catalog reads through app-server. */
public class CodexNativeDataHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CodexNativeDataHandler.class);
    private static final Gson GSON = new Gson();
    private static final Map<String, String> METHODS = Map.of(
            "codex_native_list_threads", "codex.listThreads",
            "codex_native_list_threads_page", "codex.listThreads",
            "codex_native_count_thread_messages", "codex.countThreadMessages",
            "codex_native_read_thread", "codex.readThread",
            "codex_native_list_models", "codex.listModels",
            "codex_native_list_skills", "codex.listSkills",
            "codex_native_mcp_status", "codex.getMcpStatus",
            "codex_native_mcp_reload", "codex.reloadMcp"
    );

    /** Creates a native data handler for one chat window. */
    public CodexNativeDataHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return METHODS.keySet().toArray(new String[0]);
    }

    @Override
    public boolean handle(String type, String content) {
        String method = METHODS.get(type);
        if (method == null) {
            return false;
        }
        JsonObject payload = parseObject(content);
        ClaudeSession session = this.context.getSession();
        String channelId = nonEmpty(stringValue(payload, "channelId"),
                session == null ? null : session.getChannelId());
        String cwd = nonEmpty(stringValue(payload, "cwd"),
                session == null ? null : session.getCwd());
        String threadId = nonEmpty(stringValue(payload, "threadId"),
                session == null ? null : session.getSessionId());
        JsonObject params = payload != null && payload.has("params") && payload.get("params").isJsonObject()
                ? payload.getAsJsonObject("params") : payload == null ? new JsonObject() : payload.deepCopy();
        if (payload != null) {
            params.remove("channelId");
            params.remove("cwd");
            params.remove("threadId");
            params.remove("append");
            params.remove("requestId");
        }
        CodexSDKBridge bridge = this.context.getCodexSDKBridge();
        if (bridge == null) {
            JsonObject failure = error("Codex bridge is unavailable");
            if (payload != null && payload.has("requestId")) {
                failure.add("requestId", payload.get("requestId").deepCopy());
            }
            this.publish(type, failure);
            return true;
        }
        CompletableFuture<JsonObject> result = bridge.readCodexNative(
                method, channelId, cwd, threadId, params);
        result.whenComplete((response, failure) -> {
            JsonObject output = response == null ? new JsonObject() : response.deepCopy();
            if (payload != null && payload.has("requestId")) {
                output.add("requestId", payload.get("requestId").deepCopy());
            }
            output.addProperty("cwd", cwd);
            if (failure != null) {
                output.addProperty("error", failure.getMessage() == null
                        ? "Native Codex request failed" : failure.getMessage());
            }
            publish(type, output);
        });
        return true;
    }

    private void publish(String requestType, JsonObject response) {
        JsonObject envelope = response == null ? new JsonObject() : response.deepCopy();
        envelope.addProperty("requestType", requestType);
        envelope.addProperty("source", "native");
        callJavaScript("onCodexNativeData", escapeJs(GSON.toJson(envelope)));
    }

    private static JsonObject parseObject(String content) {
        try {
            return content == null || content.trim().isEmpty()
                    ? new JsonObject() : GSON.fromJson(content, JsonObject.class);
        } catch (Exception exception) {
            LOG.debug("[CodexNativeData] Invalid request: " + exception.getMessage());
            return null;
        }
    }

    private static String stringValue(JsonObject object, String name) {
        return object != null && object.has(name) && !object.get(name).isJsonNull()
                ? object.get(name).getAsString() : null;
    }

    private static String nonEmpty(String preferred, String fallback) {
        return preferred == null || preferred.trim().isEmpty() ? fallback : preferred;
    }

    private static JsonObject error(String message) {
        JsonObject result = new JsonObject();
        result.addProperty("error", message);
        return result;
    }
}
