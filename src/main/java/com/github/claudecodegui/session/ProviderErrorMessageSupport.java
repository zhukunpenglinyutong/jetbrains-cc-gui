package com.github.claudecodegui.session;

import com.github.claudecodegui.common.CommonConstants;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Shared helper for rendering provider failures as assistant content blocks.
 */
public final class ProviderErrorMessageSupport {

    private ProviderErrorMessageSupport() {
    }

    public static Message appendToAssistantMessage(
            SessionState state,
            Message currentAssistantMessage,
            String provider,
            String details
    ) {
        String normalizedDetails = details != null ? details : "";
        Message assistantMessage = resolveAssistantMessage(state, currentAssistantMessage);

        String existingContent = assistantMessage.content != null ? assistantMessage.content : "";
        if (existingContent.isBlank()) {
            assistantMessage.content = normalizedDetails;
        } else if (!normalizedDetails.isBlank() && !existingContent.contains(normalizedDetails)) {
            assistantMessage.content = existingContent + "\n\n" + normalizedDetails;
        }

        JsonArray content = ensureAssistantRawContentArray(assistantMessage);
        JsonObject errorBlock = createProviderErrorBlock(provider, normalizedDetails, null, null);
        content.add(errorBlock);
        return assistantMessage;
    }

    public static JsonObject createProviderErrorBlock(
            String provider,
            String details,
            String summary,
            Integer exitCode
    ) {
        String normalizedDetails = details != null ? details : "";
        JsonObject errorBlock = new JsonObject();
        errorBlock.addProperty(CommonConstants.JSON_KEY_TYPE, "provider_error");
        errorBlock.addProperty("provider", provider != null && !provider.isBlank() ? provider : "unknown");
        errorBlock.addProperty("summary", summary != null && !summary.isBlank()
                ? summary
                : summarize(normalizedDetails));
        errorBlock.addProperty("details", normalizedDetails);
        if (exitCode != null) {
            errorBlock.addProperty("exitCode", exitCode);
        }
        return errorBlock;
    }

    public static String summarize(String details) {
        if (details == null || details.isBlank()) {
            return "响应失败";
        }
        String trimmed = details.trim();
        int reasonIndex = trimmed.indexOf("原因：");
        if (reasonIndex >= 0 && reasonIndex + 3 < trimmed.length()) {
            return trimmed.substring(reasonIndex + 3).trim();
        }
        return trimmed.length() <= 80 ? trimmed : trimmed.substring(0, 80) + "...";
    }

    private static Message resolveAssistantMessage(SessionState state, Message currentAssistantMessage) {
        if (currentAssistantMessage != null) {
            return currentAssistantMessage;
        }

        java.util.List<Message> messages = state.getMessagesReference();
        if (!messages.isEmpty()) {
            Message last = messages.get(messages.size() - 1);
            if (last.type == Message.Type.ASSISTANT) {
                return last;
            }
        }

        Message created = new Message(Message.Type.ASSISTANT, "", createAssistantRaw());
        state.addMessage(created);
        return created;
    }

    private static JsonObject createAssistantRaw() {
        JsonObject raw = new JsonObject();
        raw.addProperty(CommonConstants.JSON_KEY_TYPE, CommonConstants.MSG_TYPE_ASSISTANT);
        JsonObject messageObj = new JsonObject();
        messageObj.add(CommonConstants.JSON_KEY_CONTENT, new JsonArray());
        raw.add(CommonConstants.JSON_KEY_MESSAGE, messageObj);
        return raw;
    }

    private static JsonArray ensureAssistantRawContentArray(Message assistantMessage) {
        if (assistantMessage.raw == null) {
            assistantMessage.raw = createAssistantRaw();
        }

        JsonObject raw = assistantMessage.raw;
        JsonObject message = raw.has(CommonConstants.JSON_KEY_MESSAGE) && raw.get(CommonConstants.JSON_KEY_MESSAGE).isJsonObject()
                ? raw.getAsJsonObject(CommonConstants.JSON_KEY_MESSAGE)
                : new JsonObject();
        JsonArray content = message.has(CommonConstants.JSON_KEY_CONTENT) && message.get(CommonConstants.JSON_KEY_CONTENT).isJsonArray()
                ? message.getAsJsonArray(CommonConstants.JSON_KEY_CONTENT)
                : new JsonArray();

        message.add(CommonConstants.JSON_KEY_CONTENT, content);
        raw.add(CommonConstants.JSON_KEY_MESSAGE, message);
        assistantMessage.raw = raw;
        return content;
    }
}
