package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.lang.reflect.Proxy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class HistoryMessageInjectorTest {

    @Test
    public void handleLoadSessionUsesPayloadProviderAndResolvedCodexSessionId() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        boolean[] callbackInvoked = {false};

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-codex\",\"provider\":\"codex\"}",
                "claude",
                (sessionId, projectPath, provider) -> callbackInvoked[0] = true
        );

        assertEquals("hist-codex", injector.loadedCodexSessionId);
        assertFalse(callbackInvoked[0]);
    }

    @Test
    public void handleLoadSessionUsesPayloadProviderForClaudeEvenWhenCurrentProviderIsCodex() {
        RecordingHistoryMessageInjector injector = new RecordingHistoryMessageInjector(createContext("D:/project/demo"));
        String[] callbackArgs = new String[3];

        injector.handleLoadSession(
                "{\"sessionId\":\"hist-claude\",\"provider\":\"claude\"}",
                "codex",
                (sessionId, projectPath, provider) -> {
                    callbackArgs[0] = sessionId;
                    callbackArgs[1] = projectPath;
                    callbackArgs[2] = provider;
                }
        );

        assertNull(injector.loadedCodexSessionId);
        assertEquals("hist-claude", callbackArgs[0]);
        assertEquals("D:/project/demo", callbackArgs[1]);
        assertEquals("claude", callbackArgs[2]);
    }

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
        // When neither variant carries an image content block, fall back to the
        // existing tiebreaker which keeps the first record.
        assertEquals("<image name=[Image #1]>\n</image>\nhello", result.get(0).get("content").getAsString());
    }

    @Test
    public void convertCodexMessagesDeduplicatesAcrossSlightlyDifferentTimestamps() throws Exception {
        // Codex SDK flushes `response_item` and `event_msg` records at slightly
        // different moments; their timestamps differ by a handful of ms even when
        // they represent the same user turn. Dedup must NOT depend on strict
        // timestamp equality, otherwise the `<image ...>`-wrapped text leaks
        // into the rendered history (Bug 2).
        Path imagePath = Files.createTempFile("codex-history-image-jitter", ".png");
        try {
            Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(responseItemUserMessage(
                    "2026-05-20T13:53:10.701Z",
                    "<image name=[Image #1]>\n</image>\n图片内容是啥"));
            messages.add(eventUserMessage(
                    "2026-05-20T13:53:10.832Z",
                    "图片内容是啥",
                    imagePath.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            assertEquals("图片内容是啥", result.get(0).get("content").getAsString());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            // The variant with a real image content block wins.
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString()
                    .startsWith("data:image/png;base64,"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("图片内容是啥", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesKeepsRepeatedTextOnlyUserMessagesTypedSecondsApart() {
        // Guard: two identical plain-text user messages with non-trivial time
        // gap (no image signal) must remain as two separate messages.
        JsonArray messages = new JsonArray();
        messages.add(responseItemUserMessage("2026-04-30T09:40:26.701Z", "hello"));
        messages.add(eventUserMessage("2026-04-30T09:41:00.701Z", "hello"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
    }

    @Test
    public void convertCodexMessagesPreservesAllImagesWhenSingleTurnHasMultipleAttachments() throws Exception {
        // Single user turn with two attachments: response_item wraps each image
        // with its own `<image name=[Image #N]>...</image>` block, while
        // event_msg carries both paths in `local_images`. Dedup must collapse the
        // two records into the event_msg variant so both images stay rendered.
        Path imagePath1 = Files.createTempFile("codex-history-multi-image-1", ".png");
        Path imagePath2 = Files.createTempFile("codex-history-multi-image-2", ".png");
        try {
            Files.write(imagePath1, "png-bytes-1".getBytes(StandardCharsets.UTF_8));
            Files.write(imagePath2, "png-bytes-2".getBytes(StandardCharsets.UTF_8));

            JsonArray messages = new JsonArray();
            messages.add(responseItemUserMessage(
                    "2026-05-20T13:53:10.701Z",
                    "<image name=[Image #1]>\n</image>\n<image name=[Image #2]>\n</image>\n图片内容是啥"));
            messages.add(eventUserMessage(
                    "2026-05-20T13:53:10.832Z",
                    "图片内容是啥",
                    imagePath1.toString(),
                    imagePath2.toString()));

            List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

            assertEquals(1, result.size());
            assertEquals("图片内容是啥", result.get(0).get("content").getAsString());
            JsonArray contentBlocks = result.get(0).getAsJsonObject("raw").getAsJsonArray("content");
            assertEquals(3, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("image", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            // Both images must preserve distinct inline image data.
            String src1 = contentBlocks.get(0).getAsJsonObject().get("src").getAsString();
            String src2 = contentBlocks.get(1).getAsJsonObject().get("src").getAsString();
            assertTrue(src1.startsWith("data:image/png;base64,"));
            assertTrue(src2.startsWith("data:image/png;base64,"));
            assertFalse("Two images must resolve to distinct base64 data", src1.equals(src2));
            assertEquals("text", contentBlocks.get(2).getAsJsonObject().get("type").getAsString());
            assertEquals("图片内容是啥", contentBlocks.get(2).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath1);
            Files.deleteIfExists(imagePath2);
        }
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
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString()
                    .startsWith("data:image/png;base64,"));
            assertEquals("text", contentBlocks.get(1).getAsJsonObject().get("type").getAsString());
            assertEquals("hello", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void convertCodexMessagesFiltersDeveloperRoleMessages() {
        JsonArray messages = new JsonArray();
        messages.add(responseItemDeveloperMessage("2026-05-14T10:00:00.000Z", "internal developer instructions"));
        messages.add(responseItemAssistantMessage("2026-05-14T10:00:01.000Z", "visible assistant reply"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, result.size());
        assertEquals("assistant", result.get(0).get("type").getAsString());
        assertEquals("visible assistant reply", result.get(0).get("content").getAsString());
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
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString()
                    .startsWith("data:image/png;base64,"));
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

    @Test
    public void convertCodexMessagesKeepsBatchToolResultsWithinDedupWindow() {
        // Two parallel bash calls (batch run) return their function_call_output
        // entries within the dedup time window. Each tool_result is a separate
        // user message whose `content` field is the literal placeholder
        // "[tool_result]"; their raw payloads differ only by `tool_use_id`.
        // The dedup pass must NOT collapse them — otherwise the trailing
        // tool_use is left without a result and renders as a stuck pending
        // spinner in the Batch Run Commands panel.
        JsonArray messages = new JsonArray();
        messages.add(functionCallOutputResponseItem("2026-05-21T08:00:00.100Z", "call_1", "first output"));
        messages.add(functionCallOutputResponseItem("2026-05-21T08:00:00.180Z", "call_2", "second output"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());
        assertEquals("user", result.get(0).get("type").getAsString());
        assertEquals("user", result.get(1).get("type").getAsString());
        assertEquals("call_1", result.get(0).getAsJsonObject("raw").getAsJsonArray("content")
                .get(0).getAsJsonObject().get("tool_use_id").getAsString());
        assertEquals("call_2", result.get(1).getAsJsonObject("raw").getAsJsonArray("content")
                .get(0).getAsJsonObject().get("tool_use_id").getAsString());
    }

    @Test
    public void convertCodexMessagesConvertsCliCommandExecutionItemsToToolBlocks() {
        JsonArray messages = new JsonArray();
        messages.add(cliItemMessage(
                "2026-06-08T07:00:00.100Z",
                "item.started",
                "{\"id\":\"cmd_1\",\"type\":\"command_execution\",\"command\":\"git status\",\"status\":\"in_progress\"}"));
        messages.add(cliItemMessage(
                "2026-06-08T07:00:00.300Z",
                "item.completed",
                "{\"id\":\"cmd_1\",\"type\":\"command_execution\",\"command\":\"git status\",\"exit_code\":0,\"output\":\"clean\"}"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());

        JsonObject toolUse = result.get(0).getAsJsonObject("raw").getAsJsonArray("content")
                .get(0).getAsJsonObject();
        assertEquals("assistant", result.get(0).get("type").getAsString());
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("cmd_1", toolUse.get("id").getAsString());
        assertEquals("Bash", toolUse.get("name").getAsString());
        assertEquals("git status", toolUse.getAsJsonObject("input").get("command").getAsString());

        JsonObject toolResult = result.get(1).getAsJsonObject("raw").getAsJsonArray("content")
                .get(0).getAsJsonObject();
        assertEquals("user", result.get(1).get("type").getAsString());
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("cmd_1", toolResult.get("tool_use_id").getAsString());
        assertEquals("clean", toolResult.get("content").getAsString());
        assertFalse(toolResult.get("is_error").getAsBoolean());
    }

    @Test
    public void convertCodexMessagesConvertsCliMcpToolItemsToToolBlocks() {
        JsonArray messages = new JsonArray();
        messages.add(cliItemMessage(
                "2026-06-08T07:01:00.100Z",
                "item.started",
                "{\"id\":\"mcp_1\",\"type\":\"mcp_tool_call\",\"server\":\"context7\",\"tool\":\"resolve-library-id\","
                        + "\"arguments\":{\"libraryName\":\"react\"}}"));
        messages.add(cliItemMessage(
                "2026-06-08T07:01:00.300Z",
                "item.completed",
                "{\"id\":\"mcp_1\",\"type\":\"mcp_tool_call\",\"server\":\"context7\",\"tool\":\"resolve-library-id\","
                        + "\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"/facebook/react\"}]}}"));

        List<JsonObject> result = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, result.size());

        JsonObject toolUse = result.get(0).getAsJsonObject("raw").getAsJsonArray("content")
                .get(0).getAsJsonObject();
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("mcp_1", toolUse.get("id").getAsString());
        assertEquals("mcp__context7__resolve-library-id", toolUse.get("name").getAsString());
        assertEquals("react", toolUse.getAsJsonObject("input").get("libraryName").getAsString());

        JsonObject toolResult = result.get(1).getAsJsonObject("raw").getAsJsonArray("content")
                .get(0).getAsJsonObject();
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("mcp_1", toolResult.get("tool_use_id").getAsString());
        assertEquals("/facebook/react", toolResult.get("content").getAsString());
        assertFalse(toolResult.get("is_error").getAsBoolean());
    }

    private static JsonObject responseItemUserMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "user", "input_text", text);
    }

    private static JsonObject responseItemDeveloperMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "developer", "text", text);
    }

    private static JsonObject responseItemAssistantMessage(String timestamp, String text) {
        return responseItemMessage(timestamp, "assistant", "output_text", text);
    }

    private static JsonObject responseItemMessage(String timestamp, String role, String blockType, String text) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "message");
        payload.addProperty("role", role);

        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", blockType);
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
        return eventUserMessage(timestamp, text, new String[]{localImagePath});
    }

    private static JsonObject eventUserMessage(String timestamp, String text, String... localImagePaths) {
        JsonObject line = eventUserMessage(timestamp, text);
        JsonArray localImages = new JsonArray();
        for (String path : localImagePaths) {
            localImages.add(path);
        }
        line.getAsJsonObject("payload").add("local_images", localImages);
        return line;
    }

    private static JsonObject functionCallOutputResponseItem(String timestamp, String callId, String output) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", "response_item");

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call_output");
        payload.addProperty("call_id", callId);
        payload.addProperty("output", output);
        line.add("payload", payload);
        return line;
    }

    private static JsonObject cliItemMessage(String timestamp, String type, String itemJson) {
        JsonObject line = new JsonObject();
        line.addProperty("timestamp", timestamp);
        line.addProperty("type", type);
        line.add("item", com.google.gson.JsonParser.parseString(itemJson).getAsJsonObject());
        return line;
    }

    private static HandlerContext createContext(String basePath) {
        Project project = (Project) Proxy.newProxyInstance(
                HistoryMessageInjectorTest.class.getClassLoader(),
                new Class[]{Project.class},
                (proxy, method, args) -> {
                    if ("getBasePath".equals(method.getName())) {
                        return basePath;
                    }
                    if ("isDisposed".equals(method.getName())) {
                        return false;
                    }
                    Class<?> returnType = method.getReturnType();
                    if (returnType.equals(boolean.class)) {
                        return false;
                    }
                    if (returnType.equals(int.class)) {
                        return 0;
                    }
                    if (returnType.equals(long.class)) {
                        return 0L;
                    }
                    return null;
                }
        );

        return new HandlerContext(project, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    private static final class RecordingHistoryMessageInjector extends HistoryMessageInjector {
        private String loadedCodexSessionId;

        private RecordingHistoryMessageInjector(HandlerContext context) {
            super(context);
        }

        @Override
        void loadCodexSession(String sessionId) {
            this.loadedCodexSessionId = sessionId;
        }
    }
}
