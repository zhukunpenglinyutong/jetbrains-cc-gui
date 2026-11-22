package com.github.claudecodegui.handler;

import com.google.gson.JsonParser;
import org.junit.Test;
import static org.junit.Assert.*;

public class SessionHandlerUltracodeTest {
    @Test
    public void preservesExplicitFalseAndRejectsCoercedValues() {
        assertEquals(Boolean.TRUE, SessionHandler.extractClaudeUltracode(
                JsonParser.parseString("{\"claudeUltracode\":true}").getAsJsonObject()));
        assertEquals(Boolean.FALSE, SessionHandler.extractClaudeUltracode(
                JsonParser.parseString("{\"claudeUltracode\":false}").getAsJsonObject()));
        for (String payload : new String[]{"{}", "{\"claudeUltracode\":null}", "{\"claudeUltracode\":\"true\"}"}) {
            assertNull(SessionHandler.extractClaudeUltracode(JsonParser.parseString(payload).getAsJsonObject()));
        }
    }
}
