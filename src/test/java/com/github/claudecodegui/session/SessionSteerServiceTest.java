package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SteerCapableBridge;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for provider routing in {@link SessionSteerService}.
 */
public class SessionSteerServiceTest {

    @Test
    public void missingImplementationRejectsUnsupportedProvider() throws Exception {
        SessionSteerService service = new SessionSteerService();
        JsonObject result = service.steer(
                "codex", "session", "epoch", "steer-1", "hello", null, null, null
        ).get();
        assertFalse(result.get("delivered").getAsBoolean());
        assertEquals("unsupported_provider", result.get("reason").getAsString());
    }

    @Test
    public void registeredClaudeBridgeIsInvoked() throws Exception {
        SessionSteerService service = new SessionSteerService();
        AtomicBoolean called = new AtomicBoolean(false);
        SteerCapableBridge bridge = (
                String sessionId,
                String runtimeSessionEpoch,
                String steerId,
                String message,
                List<ClaudeSession.Attachment> attachments,
                String agentPrompt,
                String reasoningEffort
        ) -> {
            called.set(true);
            JsonObject ok = new JsonObject();
            ok.addProperty("delivered", true);
            return CompletableFuture.completedFuture(ok);
        };
        service.register("claude", bridge);

        JsonObject result = service.steer(
                "claude", "session", "epoch", "steer-1", "hello", null, null, null
        ).get();
        assertTrue(called.get());
        assertTrue(result.get("delivered").getAsBoolean());
    }
}
