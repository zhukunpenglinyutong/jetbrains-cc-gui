package com.github.claudecodegui.clawbot;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.List;

public final class ClawBotConversationPreview {

    private static final int MAX_QUESTION_TEXT = 300;
    private static final int MAX_ANSWER_TEXT = 800;

    private ClawBotConversationPreview() {
    }

    public static String capture(ClaudeSession session) {
        synchronized (session.getState().getMessageStateLock()) {
            return format(session.getMessages(), session.isBusy() || session.isLoading());
        }
    }

    /** Captures only public assistant text belonging to the originating turn. */
    static ClawBotProgressTracker.Response captureResponse(
            ClaudeSession session, int firstMessageIndex, Object turnOwner, String runtimeEpoch,
            ClaudeSession.Message question) {
        synchronized (session.getState().getMessageStateLock()) {
            if (!session.getState().isCurrentTurn(turnOwner)
                    || !runtimeEpoch.equals(session.getRuntimeSessionEpoch())) {
                return null;
            }
            List<ClaudeSession.Message> messages = session.getMessages();
            if (firstMessageIndex < 0 || firstMessageIndex >= messages.size()
                    || messages.get(firstMessageIndex) != question) {
                return null;
            }
            for (int index = messages.size() - 1; index > firstMessageIndex; index--) {
                ClaudeSession.Message message = messages.get(index);
                if (message.type == ClaudeSession.Message.Type.ASSISTANT) {
                    String text = visibleText(message, Integer.MAX_VALUE);
                    if (!text.isBlank()) {
                        return new ClawBotProgressTracker.Response(message, text);
                    }
                }
            }
            return new ClawBotProgressTracker.Response(null, "");
        }
    }

    static String format(List<ClaudeSession.Message> messages, boolean busy) {
        String question = "";
        String answer = "";
        for (int index = messages.size() - 1; index >= Math.max(0, messages.size() - 256); index--) {
            ClaudeSession.Message message = messages.get(index);
            if (message.type != ClaudeSession.Message.Type.USER && message.type != ClaudeSession.Message.Type.ASSISTANT) {
                continue;
            }
            int maxLength = message.type == ClaudeSession.Message.Type.USER
                    ? MAX_QUESTION_TEXT : MAX_ANSWER_TEXT;
            String visible = visibleText(message, maxLength);
            if (message.type == ClaudeSession.Message.Type.USER && !visible.isBlank()) {
                question = visible;
                break;
            }
            if (message.type == ClaudeSession.Message.Type.ASSISTANT && answer.isEmpty() && !visible.isBlank()) {
                answer = visible;
            }
        }
        String state = busy ? "处理中，最终回复尚未完成。" : "当前空闲。";
        if (question.isEmpty()) {
            return "【会话进度】\n\n" + state + "\n\n当前内存中没有可预览的一问一答；未读取磁盘历史。";
        }
        return "【会话进度】\n\n" + state + "\n\n最近提问：\n" + question + "\n\n"
                + (answer.isEmpty() ? "该问题暂无可预览的回复。" : (busy ? "当前回复片段：\n" : "最近回复：\n") + answer);
    }

    private static String visibleText(ClaudeSession.Message message, int maxLength) {
        JsonObject raw = message.raw;
        if (raw != null) {
            if (raw.has("message") && raw.get("message").isJsonObject()) {
                raw = raw.getAsJsonObject("message");
            }
            JsonElement content = raw.get("content");
            if (content != null && content.isJsonArray()) {
                StringBuilder text = new StringBuilder();
                for (JsonElement element : content.getAsJsonArray()) {
                    if (!element.isJsonObject()) {
                        continue;
                    }
                    JsonObject block = element.getAsJsonObject();
                    if (block.has("type") && block.get("type").isJsonPrimitive()
                            && "text".equals(block.get("type").getAsString())
                            && block.has("text") && block.get("text").isJsonPrimitive()
                            && block.get("text").getAsJsonPrimitive().isString()) {
                        if (!text.isEmpty()) {
                            text.append('\n');
                        }
                        text.append(bounded(block.get("text").getAsString(), maxLength));
                        if (text.length() >= maxLength) {
                            break;
                        }
                    }
                }
                return bounded(text.toString(), maxLength);
            }
        }
        return "[tool_result]".equals(message.content) ? "" : bounded(message.content, maxLength);
    }

    private static String bounded(String text, int maxLength) {
        if (text == null) {
            return "";
        }
        int end = Math.min(text.length(), maxLength);
        if (end > 0 && Character.isHighSurrogate(text.charAt(end - 1))) {
            end--;
        }
        String safe = text.substring(0, end).replaceAll("[\\p{Cntrl}&&[^\\n\\r\\t]]", "").trim();
        return text.length() > end ? safe + "…" : safe;
    }
}
