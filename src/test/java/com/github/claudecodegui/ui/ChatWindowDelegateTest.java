package com.github.claudecodegui.ui;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionLifecycleManager;
import com.github.claudecodegui.session.StreamMessageCoalescer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import javax.swing.JPanel;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
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
     * Grok's daemon copies CLAUDE_SESSION_ID once, at launch, from this bridge.
     * PermissionService only watches ask-user-question files under the same key.
     */
    @Test
    public void applySessionIdPublishesRoutingKeyIntoGrokPermissionEnv() throws Exception {
        GrokSDKBridge aligned = new GrokSDKBridge();
        GrokSDKBridge untouched = new GrokSDKBridge();
        ChatWindowDelegate delegate = new ChatWindowDelegate(grokHost(aligned));
        String routingKey = "4059a713-e5b9-4c83-858e-aadacc8cd6ca";

        invokeApplySessionId(delegate, routingKey);

        Map<String, String> alignedEnv = permissionEnv(aligned);
        Map<String, String> untouchedEnv = permissionEnv(untouched);
        assertEquals(routingKey, aligned.getSessionId());
        assertEquals(routingKey, alignedEnv.get("CLAUDE_SESSION_ID"));
        assertNotEquals(routingKey, untouchedEnv.get("CLAUDE_SESSION_ID"));
    }

    /** A window that has not created a Grok bridge must still accept the routing key. */
    @Test
    public void applySessionIdSkipsAMissingGrokBridge() throws Exception {
        ChatWindowDelegate delegate = new ChatWindowDelegate(grokHost(null));
        invokeApplySessionId(delegate, "4059a713-e5b9-4c83-858e-aadacc8cd6ca");
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
                        (proxy, method, args) -> {
                            if ("callJavaScript".equals(method.getName())
                                    || "isAvailable".equals(method.getName())) {
                                return true;
                            }
                            return defaultValue(method.getReturnType());
                        }
                );
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(coalescerTarget);
        // handleFrontendReady replays pending dialogs through the host's permission
        // handler, so the double needs a real (empty) one rather than a null.
        PermissionHandler permissionHandler = new PermissionHandler(new HandlerContext(
                null,
                null,
                null,
                null,
                (HandlerContext.JsCallback) Proxy.newProxyInstance(
                        HandlerContext.JsCallback.class.getClassLoader(),
                        new Class<?>[]{HandlerContext.JsCallback.class},
                        (proxy, method, args) -> defaultValue(method.getReturnType())
                )
        ));

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
                                case "getPermissionHandler":
                                    return permissionHandler;
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

    private static ChatWindowDelegate.DelegateHost grokHost(GrokSDKBridge grokSDKBridge) {
        return (ChatWindowDelegate.DelegateHost) Proxy.newProxyInstance(
                ChatWindowDelegate.DelegateHost.class.getClassLoader(),
                new Class<?>[]{ChatWindowDelegate.DelegateHost.class},
                (proxy, method, args) -> {
                    if ("getGrokSDKBridge".equals(method.getName())) {
                        return grokSDKBridge;
                    }
                    if ("getCliBridges".equals(method.getName())) {
                        return Map.of();
                    }
                    return defaultValue(method.getReturnType());
                }
        );
    }

    private static void invokeApplySessionId(ChatWindowDelegate delegate, String routingKey) throws Exception {
        Method apply = ChatWindowDelegate.class.getDeclaredMethod("applySessionIdToBridges", String.class);
        apply.setAccessible(true);
        apply.invoke(delegate, routingKey);
    }

    /** Permission block written into the daemon environment before process start. */
    private static Map<String, String> permissionEnv(GrokSDKBridge bridge) throws Exception {
        Field field = BaseSDKBridge.class.getDeclaredField("envConfigurator");
        field.setAccessible(true);
        EnvironmentConfigurator configurator = (EnvironmentConfigurator) field.get(bridge);
        Map<String, String> env = new HashMap<>();
        configurator.configurePermissionEnv(env);
        return env;
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
