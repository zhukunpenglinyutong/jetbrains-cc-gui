package com.github.claudecodegui.ui.toolwindow;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Contract test for the inter_turn_message envelope handed to
 * {@code window.onInterTurnMessage}.
 *
 * <p>Regression guard: the daemon emits {@code {sessionId, message}}, but the
 * first version forwarded only {@code message}. The webview drops any event
 * whose {@code sessionId} is not a string, so every real follow-up report
 * vanished while the webview-only tests kept passing — they fed a hand-built
 * envelope and skipped this layer entirely.</p>
 */
public class InterTurnMessagePayloadTest {

    private final Gson gson = new Gson();

    @Test
    public void payloadKeepsSessionIdAlongsideMessage() {
        JsonObject message = new JsonObject();
        message.addProperty("type", "assistant");
        message.addProperty("uuid", "u-1");

        String json = ClaudeChatWindow.buildInterTurnMessagePayload("s1", message);
        JsonObject payload = gson.fromJson(json, JsonObject.class);

        assertEquals("s1", payload.get("sessionId").getAsString());
        assertTrue(payload.get("message").isJsonObject());
        assertEquals("u-1", payload.getAsJsonObject("message").get("uuid").getAsString());
    }

    @Test
    public void payloadRoundTripsNestedToolResultBlocks() {
        JsonObject message = gson.fromJson(
                "{\"type\":\"user\",\"uuid\":\"tr-1\",\"message\":{\"role\":\"user\","
                        + "\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"content\":\"ok\"}]}}",
                JsonObject.class);

        String json = ClaudeChatWindow.buildInterTurnMessagePayload("s1", message);
        JsonObject payload = gson.fromJson(json, JsonObject.class);
        JsonObject roundTripped = payload.getAsJsonObject("message");

        assertEquals("user", roundTripped.get("type").getAsString());
        assertEquals("tool_result", roundTripped.getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
    }
}
