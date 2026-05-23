package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class HistoryMessageInjectorTest {

    @Test
    public void convertCodexMessagesDeduplicatesDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("user", result.get(0).get("type").getAsString());
        assertEquals("hello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesKeepsRepeatedUserMessagesWithDifferentTimestamps() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:40:27.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
    }

    @Test
    public void convertCodexMessagesDeduplicatesImageWrappedDualRecordedUserMessage() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "<image name=[Image #1]>\n</image>\nhello"));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("<image name=[Image #1]>\n</image>\nhello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesStripsAgentsInstructionsFromDuplicatedUserMessage() {
        String text = "<agents-instructions>\n"
                + "# Global Instructions\n\n"
                + "请默认使用中文（简体）回复。\n"
                + "</agents-instructions>\n\n"
                + "hello";
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", text));
        messages.add(eventUserMessage("2026-04-30T09:40:26.701Z", text));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("hello", result.get(0).get("content").getAsString());
        assertEquals("hello", result.get(0)
                .getAsJsonObject("raw")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject()
                .get("text")
                .getAsString());
    }

    @Test
    public void convertCodexMessagesRestoresLocalImagesFromEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:02:20.861Z", "hello", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("image/png", contentBlocks.get(0).getAsJsonObject().get("mediaType").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("hello", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesKeepsImageOnlyEventMessage() throws Exception {
        Path imagePath = Files.createTempFile("codex-history-image-only", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(eventUserMessage("2026-05-11T09:03:20.861Z", "", imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            assertEquals("", result.get(0).get("content").getAsString());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(1, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesStripsAppendedProjectModulesContext() {
        JsonArray messages = new JsonArray();
        messages.add(eventUserMessage(
                "2026-05-11T09:03:20.861Z",
                "只保留用户输入\n\n## Project Modules\n\nThis project contains multiple modules:\n- `idea-claude-code-gui`\n"
        ));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("只保留用户输入", result.get(0).get("content").getAsString());
        JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
        assertEquals(1, contentBlocks.size());
        assertEquals("只保留用户输入", contentBlocks.get(0).getAsJsonObject().get("text").getAsString());
    }

    private static JsonObject responseItemUserMessage(String timestamp, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "message");
        payload.addProperty("role", "user");

        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "input_text");
        block.addProperty("text", text);
        content.add(block);

        payload.add("content", content);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "event_msg");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "user_message");
        payload.addProperty("message", text);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject eventUserMessage(String timestamp, String text, String localImagePath) {
        JsonObject line = eventUserMessage(timestamp, text);
        JsonArray localImages = new JsonArray();
        localImages.add(localImagePath);
        line.getAsJsonObject("payload").add("local_images", localImages);
        return line;
    }
}
