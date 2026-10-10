package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Locks the runtime-generation gate. Node assigns runtimeGeneration per
 * CodexAppServerService instance, so every daemon restart resets the counter to
 * 1; the gate must scope its monotonic comparison to the producing daemon
 * process or a restart would permanently drop a channel's event stream
 * (interaction dialogs included).
 */
public class CodexSDKBridgeRuntimeGenerationTest {

    @Test
    public void lowerGenerationInsideOneDaemonProcessIsStale() {
        CodexSDKBridge.RuntimeGenerationScope previous =
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "3");
        assertTrue(CodexSDKBridge.isStaleRuntimeEvent(previous,
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "2")));
        assertFalse(CodexSDKBridge.isStaleRuntimeEvent(previous,
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "3")));
        assertFalse(CodexSDKBridge.isStaleRuntimeEvent(previous,
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "4")));
    }

    @Test
    public void daemonRestartWithLowerCounterDeliversTheEvent() {
        CodexSDKBridge.RuntimeGenerationScope previous =
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "3");
        // A restarted process on the same bridge object increments only the
        // process generation; a replaced bridge object increments the
        // coordinator generation.
        assertFalse(CodexSDKBridge.isStaleRuntimeEvent(previous,
                new CodexSDKBridge.RuntimeGenerationScope(1, 5, "1")));
        assertFalse(CodexSDKBridge.isStaleRuntimeEvent(previous,
                new CodexSDKBridge.RuntimeGenerationScope(2, 1, "1")));
    }

    @Test
    public void malformedGenerationValuesNeverDropEvents() {
        CodexSDKBridge.RuntimeGenerationScope previous =
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "3");
        assertFalse(CodexSDKBridge.isStaleRuntimeEvent(previous,
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "not-a-number")));
        assertFalse(CodexSDKBridge.isStaleRuntimeEvent(
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "not-a-number"),
                new CodexSDKBridge.RuntimeGenerationScope(1, 4, "2")));
    }

    @Test
    public void eventRoutingDeliversFreshGenerationsAndDropsStaleOnes() throws Exception {
        Path dir = Files.createTempDirectory("codex-generation-test");
        CapturingCallback callback = new CapturingCallback();
        CodexSDKBridge bridge = new CodexSDKBridge(dir, new CodemossSettingsService(), () -> null, dir.toString());
        try {
            Field callbacks = CodexSDKBridge.class.getDeclaredField("activeCallbacks");
            callbacks.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<String, MessageCallback> activeCallbacks = (Map<String, MessageCallback>) callbacks.get(bridge);
            activeCallbacks.put("ch", callback);

            bridge.handleCodexDaemonEvent("codex_event", event("3"));
            assertEquals(1, callback.runtimeEvents.size());

            // Stale trailing event from the same daemon process is dropped.
            bridge.handleCodexDaemonEvent("codex_event", event("2"));
            assertEquals(1, callback.runtimeEvents.size());

            bridge.handleCodexDaemonEvent("codex_event", event("4"));
            assertEquals(2, callback.runtimeEvents.size());
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    private static JsonObject event(String runtimeGeneration) {
        JsonObject event = new JsonObject();
        event.addProperty("channelId", "ch");
        event.addProperty("sessionEpoch", "epoch-1");
        event.addProperty("runtimeGeneration", runtimeGeneration);
        event.addProperty("kind", "runtimeStateChanged");
        JsonObject payload = new JsonObject();
        payload.addProperty("state", "idle");
        event.add("payload", payload);
        return event;
    }

    private static final class CapturingCallback implements MessageCallback {
        final List<JsonObject> runtimeEvents = new CopyOnWriteArrayList<>();

        @Override
        public void onMessage(String type, String content) {
            if ("codex_runtime_event".equals(type)) {
                this.runtimeEvents.add(new JsonObject());
            }
        }

        @Override
        public void onError(String error) { }

        @Override
        public void onComplete(com.github.claudecodegui.provider.common.SDKResult result) { }
    }
}
