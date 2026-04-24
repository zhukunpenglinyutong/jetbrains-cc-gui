package com.github.claudecodegui.session;

import com.github.claudecodegui.session.ClaudeSession.Message;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Tests for {@link ClaudeMessageHandler#ensureRawBlocksConsistency()}.
 *
 * <p>The method is private, so these tests use reflection to seed internal state
 * ({@code assistantContent}, {@code currentAssistantMessage.raw}) and to invoke the
 * method directly. This isolates the raw-block consistency logic from the rest of the
 * streaming pipeline, where triggering the drift scenario through public {@code onMessage}
 * calls requires a complex sequence of conservative syncs and deltas.</p>
 */
public class ClaudeMessageHandlerRawConsistencyTest {

    private ClaudeMessageHandler handler;

    @Before
    public void setUp() {
        SessionState state = new SessionState();
        MessageParser messageParser = new MessageParser();
        MessageMerger messageMerger = new MessageMerger();
        Gson gson = new GsonBuilder().create();

        handler = new ClaudeMessageHandler(
                null,
                state,
                new CallbackHandler(),
                messageParser,
                messageMerger,
                gson
        );
    }

    @Test
    public void doesNothing_whenCurrentAssistantMessageIsNull() throws Exception {
        setAssistantContent("Hello");

        invokeEnsureRawBlocksConsistency();

        assertNull("currentAssistantMessage should stay null", getCurrentAssistantMessage());
    }

    @Test
    public void doesNothing_whenAccumulatedTextIsEmpty() throws Exception {
        Message msg = newAssistantMessage(textBlock("Hello"));
        setCurrentAssistantMessage(msg);
        setAssistantContent("");

        invokeEnsureRawBlocksConsistency();

        assertEquals("Hello", lastTextBlockText(msg));
    }

    @Test
    public void fixesLastTextBlock_whenItIsShorterThanAccumulator() throws Exception {
        Message msg = newAssistantMessage(textBlock("Hel"));
        setCurrentAssistantMessage(msg);
        setAssistantContent("Hello world");

        invokeEnsureRawBlocksConsistency();

        assertEquals("Hello world", lastTextBlockText(msg));
    }

    @Test
    public void leavesLastTextBlockUnchanged_whenAlreadyConsistent() throws Exception {
        Message msg = newAssistantMessage(textBlock("Hello world"));
        setCurrentAssistantMessage(msg);
        setAssistantContent("Hello world");

        invokeEnsureRawBlocksConsistency();

        assertEquals("Hello world", lastTextBlockText(msg));
    }

    /**
     * When multiple text blocks exist (split around tool_use), only the last block
     * should receive the tail of assistantContent; preceding blocks must stay intact.
     */
    @Test
    public void preservesPrecedingTextBlocks_whenFixingLastBlock() throws Exception {
        Message msg = newAssistantMessage(
                textBlock("Hello "),
                toolUseBlock("search"),
                textBlock("wor")
        );
        setCurrentAssistantMessage(msg);
        setAssistantContent("Hello world");

        invokeEnsureRawBlocksConsistency();

        JsonArray content = contentArray(msg);
        assertEquals("text", content.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("Hello ", content.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("tool_use", content.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("text", content.get(2).getAsJsonObject().get("type").getAsString());
        assertEquals("world", content.get(2).getAsJsonObject().get("text").getAsString());
    }

    /**
     * When assistantContent is shorter than the sum of preceding text block lengths,
     * raw and accumulator have drifted. The method should leave raw untouched (it
     * cannot recover safely) rather than producing an empty or negative-offset substring.
     */
    @Test
    public void leavesBlocksUnchanged_whenAccumulatorShorterThanPrecedingLength() throws Exception {
        Message msg = newAssistantMessage(
                textBlock("Long preceding text"),
                textBlock("tail")
        );
        setCurrentAssistantMessage(msg);
        setAssistantContent("Hi");

        invokeEnsureRawBlocksConsistency();

        JsonArray content = contentArray(msg);
        assertEquals("Long preceding text", content.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("tail", content.get(1).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void doesNothing_whenNoTextBlocksExist() throws Exception {
        Message msg = newAssistantMessage(toolUseBlock("search"));
        setCurrentAssistantMessage(msg);
        setAssistantContent("Hello");

        invokeEnsureRawBlocksConsistency();

        JsonArray content = contentArray(msg);
        assertEquals(1, content.size());
        assertEquals("tool_use", content.get(0).getAsJsonObject().get("type").getAsString());
    }

    @Test
    public void doesNotShrinkLastTextBlock_whenItIsAlreadyLongerThanExpected() throws Exception {
        Message msg = newAssistantMessage(textBlock("Hello world extra"));
        setCurrentAssistantMessage(msg);
        setAssistantContent("Hello");

        invokeEnsureRawBlocksConsistency();

        assertEquals("Hello world extra", lastTextBlockText(msg));
    }

    // --- helpers -----------------------------------------------------------

    private Message newAssistantMessage(JsonObject... blocks) {
        JsonObject raw = new JsonObject();
        raw.addProperty("type", "assistant");
        JsonObject messageObj = new JsonObject();
        JsonArray content = new JsonArray();
        for (JsonObject block : blocks) {
            content.add(block);
        }
        messageObj.add("content", content);
        raw.add("message", messageObj);
        return new Message(Message.Type.ASSISTANT, "", raw);
    }

    private JsonObject textBlock(String text) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        return block;
    }

    private JsonObject toolUseBlock(String name) {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("name", name);
        return block;
    }

    private JsonArray contentArray(Message msg) {
        return msg.raw.getAsJsonObject("message").getAsJsonArray("content");
    }

    private String lastTextBlockText(Message msg) {
        JsonArray content = contentArray(msg);
        String last = null;
        for (int i = 0; i < content.size(); i++) {
            JsonObject block = content.get(i).getAsJsonObject();
            if (block.has("type") && "text".equals(block.get("type").getAsString())) {
                last = block.get("text").getAsString();
            }
        }
        return last;
    }

    private void invokeEnsureRawBlocksConsistency() throws Exception {
        Method method = ClaudeMessageHandler.class.getDeclaredMethod("ensureRawBlocksConsistency");
        method.setAccessible(true);
        method.invoke(handler);
    }

    private void setAssistantContent(String text) throws Exception {
        Field field = ClaudeMessageHandler.class.getDeclaredField("assistantContent");
        field.setAccessible(true);
        StringBuilder sb = (StringBuilder) field.get(handler);
        sb.setLength(0);
        sb.append(text);
    }

    private void setCurrentAssistantMessage(Message message) throws Exception {
        Field field = ClaudeMessageHandler.class.getDeclaredField("currentAssistantMessage");
        field.setAccessible(true);
        field.set(handler, message);
    }

    private Message getCurrentAssistantMessage() throws Exception {
        Field field = ClaudeMessageHandler.class.getDeclaredField("currentAssistantMessage");
        field.setAccessible(true);
        return (Message) field.get(handler);
    }
}
