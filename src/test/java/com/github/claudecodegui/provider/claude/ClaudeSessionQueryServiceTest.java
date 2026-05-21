package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.AttachmentResourceService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ClaudeSessionQueryServiceTest {

    @Test
    public void normalizeClaudeHistoryMessageRestoresImageBlocksAndKeepsUserText() throws IOException {
        Path imagePath = Files.createTempFile("claude-history-image", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(
                    createUserMessage("[Image #1: " + imagePath + "]\n\n"
                            + "The user has attached the image(s) above. Please use the Read tool to view them.\n\n"
                            + "请分析这张图片")
            );

            JsonArray contentBlocks = normalized.getAsJsonObject("message").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString()
                    .startsWith(AttachmentResourceService.ATTACHMENT_RESOURCE_ORIGIN + "/"));
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("previewSrc").getAsString()
                    .startsWith(AttachmentResourceService.ATTACHMENT_RESOURCE_ORIGIN + "/"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("请分析这张图片", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void normalizeClaudeHistoryMessageKeepsImageOnlyPromptAsImageBlock() throws IOException {
        Path imagePath = Files.createTempFile("claude-history-image-only", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(
                    createUserMessage("[Image #1: " + imagePath + "]\n\n"
                            + "The user has attached the image(s) above. Please use the Read tool to view them.")
            );

            JsonArray contentBlocks = normalized.getAsJsonObject("message").getAsJsonArray("content");
            assertEquals(1, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString()
                    .startsWith(AttachmentResourceService.ATTACHMENT_RESOURCE_ORIGIN + "/"));
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void normalizeClaudeHistoryMessageRestoresBareImagePathLines() throws IOException {
        Path imagePath = Files.createTempFile("claude-history-bare-image", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(
                    createUserMessage("Analyze this image\n\n" + imagePath)
            );

            JsonArray contentBlocks = normalized.getAsJsonObject("message").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            JsonObject imageBlock = contentBlocks.get(0).getAsJsonObject();
            assertEquals("image", imageBlock.get("type").getAsString());
            assertEquals("resource_url", imageBlock.get("sourceKind").getAsString());
            assertEquals(imagePath.toAbsolutePath().toString(), imageBlock.get("localPath").getAsString());
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("Analyze this image", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void normalizeClaudeHistoryMessageStripsAppendedProjectModulesContext() throws IOException {
        Path imagePath = Files.createTempFile("claude-history-image-context", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(
                    createUserMessage("[Image #1: " + imagePath + "]\n\n"
                            + "The user has attached the image(s) above. Please use the Read tool to view them.\n\n"
                            + "用户原始描述\n\n"
                            + "## Project Modules\n\n"
                            + "This project contains multiple modules:\n"
                            + "- `idea-claude-code-gui`\n")
            );

            JsonArray contentBlocks = normalized.getAsJsonObject("message").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("用户原始描述", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void normalizeClaudeHistoryMessageDoesNotDuplicateExistingImageBlock() throws IOException {
        // SDK-mode writes persist both an `image` content block and an inline
        // "[Image #N: path]" text reference. The loader must NOT create a second
        // image block from that text, otherwise the same image renders twice.
        Path imagePath = Files.createTempFile("claude-history-image-sdk", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonObject originalMessage = createUserMessageWithImageAndTextRef(imagePath);
            JsonObject normalized = ClaudeSessionQueryService.normalizeClaudeHistoryMessage(originalMessage);

            JsonArray contentBlocks = normalized.getAsJsonObject("message").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            JsonObject preservedImage = contentBlocks.get(0).getAsJsonObject();
            assertEquals("image", preservedImage.get("type").getAsString());
            // Must be the original block (base64 source), NOT a regenerated resource_url block.
            assertTrue(preservedImage.has("source"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("请分析这张图片", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    private JsonObject createUserMessageWithImageAndTextRef(Path imagePath) {
        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");
        JsonObject source = new JsonObject();
        source.addProperty("type", "base64");
        source.addProperty("media_type", "image/png");
        source.addProperty("data", "cG5nLWJ5dGVz");
        imageBlock.add("source", source);

        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", "[Image #1: " + imagePath + "]\n\n"
                + "The user has attached the image(s) above. Please use the Read tool to view them.\n\n"
                + "请分析这张图片");

        JsonArray content = new JsonArray();
        content.add(imageBlock);
        content.add(textBlock);

        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.add("message", message);
        return raw;
    }

    private JsonObject createUserMessage(String text) {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);

        JsonArray content = new JsonArray();
        content.add(textBlock);

        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.add("message", message);
        return raw;
    }
}
