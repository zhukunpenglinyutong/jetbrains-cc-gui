package com.github.claudecodegui.ui;

import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionLifecycleManager;
import com.github.claudecodegui.session.StreamMessageCoalescer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import javax.swing.JPanel;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for WebView recovery state serialization, context-limit compatibility,
 * and frontend-ready state ownership in {@link ChatWindowDelegate}.
 */
public class ChatWindowDelegateTest {

    /** Verifies that recovery serializes the complete authoritative Session selection state. */
    @Test
    public void buildsAuthoritativeBackendTabState() {
        String json = ChatWindowDelegate.buildBackendTabStateJson(
                "codex",
                "gpt-5.6-sol",
                "bypassPermissions",
                "high",
                "fast"
        );

        JsonObject state = JsonParser.parseString(json).getAsJsonObject();
        assertEquals("codex", state.get("provider").getAsString());
        assertEquals("gpt-5.6-sol", state.get("model").getAsString());
        assertEquals("bypassPermissions", state.get("permissionMode").getAsString());
        assertEquals("high", state.get("reasoningEffort").getAsString());
        assertEquals("fast", state.get("codexFastMode").getAsString());
    }

    /** Verifies that recovery preserves v0.5's provider-aware Codex context-window lookup. */
    @Test
    public void resolvesCodexRecoveryLimitThroughExistingProviderConfiguration() {
        int limit = ChatWindowDelegate.resolveModelContextLimitForRecovery(
                "codex",
                "gpt-5.6-sol",
                null
        );

        assertEquals(SettingsHandler.getModelContextLimit("codex", "gpt-5.6-sol"), limit);
    }

    /**
     * Verifies that initial load and pre-ready startup retry keep frontend ownership and do not
     * receive the Java-authoritative runtime recovery snapshot.
     */
    @Test
    public void frontendReadyDoesNotApplyBackendTabStateOutsideRuntimeRecovery() {
        List<String> javaScriptCalls = new ArrayList<>();
        ChatWindowDelegate delegate = createFrontendReadyDelegate(false, javaScriptCalls);

        delegate.handleFrontendReady();

        assertFalse(javaScriptCalls.contains("window.applyBackendTabState"));
        assertTrue(javaScriptCalls.contains("showLoading"));
    }

    /**
     * Verifies that runtime recovery applies exactly one Java-authoritative tab snapshot before
     * replaying the current transcript state to the reconstructed frontend.
     */
    @Test
    public void frontendReadyAppliesBackendTabStateOnlyDuringRuntimeRecovery() {
        List<String> javaScriptCalls = new ArrayList<>();
        ChatWindowDelegate delegate = createFrontendReadyDelegate(true, javaScriptCalls);

        delegate.handleFrontendReady();

        int snapshotIndex = javaScriptCalls.indexOf("window.applyBackendTabState");
        int replayIndex = javaScriptCalls.indexOf("showLoading");
        assertEquals(1, Collections.frequency(javaScriptCalls, "window.applyBackendTabState"));
        assertTrue(snapshotIndex >= 0);
        assertTrue(replayIndex >= 0);
        assertTrue(snapshotIndex < replayIndex);
    }

    /**
     * Creates a behavior-level delegate with minimal safe lifecycle collaborators and records
     * every Java-to-frontend function invocation in call order.
     */
    private static ChatWindowDelegate createFrontendReadyDelegate(
            boolean runtimeRecovery,
            List<String> javaScriptCalls
    ) {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setModel("gpt-5.6-sol");

        WebviewWatchdog watchdog = new WebviewWatchdog(
                new JPanel(),
                () -> null,
                () -> { },
                () -> { },
                () -> false,
                () -> false,
                () -> true
        );
        SessionLifecycleManager lifecycleManager = new SessionLifecycleManager(null) {
            @Override
            public void sendCurrentPermissionMode() {
                // Permission-mode delivery is independent of the recovery snapshot gate.
            }
        };
        StreamMessageCoalescer.JsCallbackTarget coalescerTarget =
                (StreamMessageCoalescer.JsCallbackTarget) Proxy.newProxyInstance(
                        StreamMessageCoalescer.JsCallbackTarget.class.getClassLoader(),
                        new Class<?>[]{StreamMessageCoalescer.JsCallbackTarget.class},
                        (proxy, method, args) -> defaultValue(method.getReturnType())
                );
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(coalescerTarget);

        ChatWindowDelegate.DelegateHost host =
                (ChatWindowDelegate.DelegateHost) Proxy.newProxyInstance(
                        ChatWindowDelegate.DelegateHost.class.getClassLoader(),
                        new Class<?>[]{ChatWindowDelegate.DelegateHost.class},
                        (proxy, method, args) -> {
                            switch (method.getName()) {
                                case "getSession":
                                    return session;
                                case "getWebviewWatchdog":
                                    return watchdog;
                                case "getSessionLifecycleManager":
                                    return lifecycleManager;
                                case "getStreamCoalescer":
                                    return coalescer;
                                case "isRuntimeRecoveryPage":
                                    return runtimeRecovery;
                                case "callJavaScript":
                                    javaScriptCalls.add((String) args[0]);
                                    return null;
                                default:
                                    return defaultValue(method.getReturnType());
                            }
                        }
                );
        return new ChatWindowDelegate(host);
    }

    /** Returns the JVM default value for an unneeded method on a dynamic test collaborator. */
    private static Object defaultValue(Class<?> returnType) {
        if (!returnType.isPrimitive()) {
            return null;
        }
        if (returnType == boolean.class) {
            return false;
        }
        if (returnType == char.class) {
            return '\0';
        }
        if (returnType == byte.class) {
            return (byte) 0;
        }
        if (returnType == short.class) {
            return (short) 0;
        }
        if (returnType == int.class) {
            return 0;
        }
        if (returnType == long.class) {
            return 0L;
        }
        if (returnType == float.class) {
            return 0F;
        }
        if (returnType == double.class) {
            return 0D;
        }
        return null;
    }
}
