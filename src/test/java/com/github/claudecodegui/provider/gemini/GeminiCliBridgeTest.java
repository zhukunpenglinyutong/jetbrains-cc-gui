package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.session.SessionProviderRouter;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Contract tests for the Gemini marker bridge (Story 1.2).
 *
 * <p>The provider id and stdin env key are load-bearing across the stack:
 * {@link SessionProviderRouter} routes on the provider id and the Node side
 * ({@code ai-bridge/utils/stdin-utils.js STDIN_ENV_BY_PROVIDER}) switches JSON
 * stdin mode on the env key. A mismatch on either silently breaks every send.
 */
public class GeminiCliBridgeTest {

    @Test
    public void providerIdIsGeminiAndRegisteredAsCliProvider() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        assertEquals("gemini", bridge.providerId());
        assertTrue(
                "gemini must be routed as a headless CLI provider",
                SessionProviderRouter.isCliProvider("gemini"));
    }

    @Test
    public void stdinEnvKeyMatchesNodeStdinUtilsMap() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        // ai-bridge/utils/stdin-utils.js STDIN_ENV_BY_PROVIDER.gemini
        assertEquals("GEMINI_USE_STDIN", bridge.getStdinEnvKey());
    }

    @Test
    public void extendsMarkerCliBridgeForSharedMarkerParsing() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        assertTrue(bridge instanceof MarkerCliBridge);
    }

    @Test
    public void historyReaderIsDeferredToStory17() {
        GeminiCliBridge bridge = new GeminiCliBridge();
        List<com.google.gson.JsonObject> messages = bridge.getSessionMessages("sess-1", "/tmp");
        assertTrue(messages.isEmpty());
    }

    @Test
    public void registrationMakesGeminiResolvableThroughTheRouter() {
        // Registration observability: if the gemini bridge stops being registered
        // (ClaudeChatWindow → SessionProviderRouter.registerCliBridges), sends
        // for provider "gemini" fall into the "no CLI bridge" rejection path and
        // every turn fails. This test fails the build the moment the router map
        // no longer resolves the provider id.
        java.util.Map<String, MarkerCliBridge> bridges =
                SessionProviderRouter.registerCliBridges(new GeminiCliBridge());
        assertTrue(
                "registerCliBridges must key the router map by the gemini provider id",
                bridges.containsKey("gemini"));
        assertTrue(bridges.get("gemini") instanceof GeminiCliBridge);
        assertTrue(SessionProviderRouter.isCliProvider("gemini"));
    }

    @Test
    public void stdinPayloadCarriesGuardedCwdAndPreClampRequestedCwd() {
        // BS-1: Java clamps cwd BEFORE the bridge, which erases the
        // requested-vs-used difference the Node substitution notice needs. The
        // stdin payload must therefore carry both values.
        com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                "hello", "sess-1", "/proj/base", "", "medium",
                java.util.Collections.emptyList(), "default", null, "/unsafe/requested");

        assertEquals("/proj/base", payload.get("cwd").getAsString());
        assertEquals("/unsafe/requested", payload.get("requestedCwd").getAsString());
        assertEquals("hello", payload.get("message").getAsString());
        assertEquals("default", payload.get("permissionMode").getAsString());
    }

    @Test
    public void stdinPayloadOmitsRequestedCwdWhenAbsent() {
        // Providers/services that don't use the field must not see a blank key.
        com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                "hello", "", "/proj/base", "", "medium",
                java.util.Collections.emptyList(), "default", null, null);
        assertTrue(!payload.has("requestedCwd"));

        com.google.gson.JsonObject blank = MarkerCliBridge.buildCliStdinPayload(
                "hello", "", "/proj/base", "", "medium",
                java.util.Collections.emptyList(), "default", null, "   ");
        assertTrue(!blank.has("requestedCwd"));
    }

    @Test
    public void stdinPayloadCarriesAttachmentsForMaterialization() {
        List<com.github.claudecodegui.session.ClaudeSession.Attachment> attachments = List.of(
                new com.github.claudecodegui.session.ClaudeSession.Attachment("shot.png", "image/png", "aGVsbG8="));
        com.google.gson.JsonObject payload = MarkerCliBridge.buildCliStdinPayload(
                "look", "", "/proj/base", "", "medium", attachments, "default", null, "");
        assertTrue(payload.has("attachments"));
        assertEquals(1, payload.getAsJsonArray("attachments").size());
        assertEquals("shot.png", payload.getAsJsonArray("attachments").get(0)
                .getAsJsonObject().get("fileName").getAsString());
    }
}
