package com.github.claudecodegui.session.normalize;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

public final class CodexCliMessageNormalizer extends ForwardingMessageNormalizer {
    private final Gson gson = new Gson();

    public CodexCliMessageNormalizer(MessageCallback delegate) {
        super(delegate);
    }

    @Override
    public void onMessage(String type, String content) {
        if ("assistant".equals(type) && isTextOnlyAssistantSnapshot(content)) {
            return;
        }
        super.onMessage(type, content);
    }

    private boolean isTextOnlyAssistantSnapshot(String content) {
        if (content == null || content.isBlank() || !content.trim().startsWith("{")) {
            return false;
        }
        try {
            JsonObject raw = gson.fromJson(content, JsonObject.class);
            JsonArray blocks = contentBlocks(raw);
            if (blocks == null || blocks.size() == 0) {
                return false;
            }
            for (int i = 0; i < blocks.size(); i++) {
                if (!blocks.get(i).isJsonObject()) {
                    return false;
                }
                JsonObject block = blocks.get(i).getAsJsonObject();
                String blockType = block.has("type") && !block.get("type").isJsonNull()
                        ? block.get("type").getAsString()
                        : "";
                if (!"text".equals(blockType)) {
                    return false;
                }
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private JsonArray contentBlocks(JsonObject raw) {
        if (raw == null) {
            return null;
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject message = raw.getAsJsonObject("message");
            if (message.has("content") && message.get("content").isJsonArray()) {
                return message.getAsJsonArray("content");
            }
        }
        if (raw.has("content") && raw.get("content").isJsonArray()) {
            return raw.getAsJsonArray("content");
        }
        return null;
    }
}
