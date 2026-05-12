package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

public class MessageParserTest {

    @Test
    public void parseServerMessageKeepsUserMessageWithOnlyImageBlocks() {
        MessageParser parser = new MessageParser();

        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");
        imageBlock.addProperty("src", "data:image/png;base64,abc123");

        JsonArray content = new JsonArray();
        content.add(imageBlock);

        JsonObject message = new JsonObject();
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", "user");
        raw.add("message", message);

        ClaudeSession.Message parsed = parser.parseServerMessage(raw);

        assertNotNull(parsed);
        assertEquals(ClaudeSession.Message.Type.USER, parsed.type);
        assertEquals("", parsed.content);
        assertEquals(raw, parsed.raw);
    }
}
