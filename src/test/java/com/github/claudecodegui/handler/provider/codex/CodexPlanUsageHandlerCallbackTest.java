package com.github.claudecodegui.handler.provider.codex;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Contract-pins the Codex plan-usage bridge wiring so a rename or typo cannot
 * silently break the ContextBar indicator.
 */
public class CodexPlanUsageHandlerCallbackTest {

    @Test
    public void codexPlanUsagePushesThroughTheContractedJsCallback() {
        assertEquals(
                "window.updateCodexPlanUsage",
                CodexPlanUsageHandler.CODEX_PLAN_USAGE_CALLBACK);
    }

    @Test
    public void codexPlanUsageDispatchTypeMatchesTheWebviewPollCommand() {
        assertEquals("get_codex_plan_usage", CodexPlanUsageHandler.DISPATCH_TYPE);
        assertArrayEquals(
                new String[]{CodexPlanUsageHandler.DISPATCH_TYPE},
                new CodexPlanUsageHandler(null).getSupportedTypes());
    }

    @Test
    public void unknownDispatchTypeIsRejectedWithoutTouchingTheContext() {
        assertFalse(new CodexPlanUsageHandler(null).handle("get_claude_plan_usage", null));
    }

    @Test
    public void skipsProbeAndCallbackWhenContextIsDisposed() {
        AtomicInteger jsCalls = new AtomicInteger(0);
        List<Runnable> queued = new ArrayList<>();
        Application previous = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(
                Application.class.getClassLoader(),
                new Class<?>[]{Application.class},
                (proxy, method, args) -> {
                    if ("executeOnPooledThread".equals(method.getName())) {
                        queued.add((Runnable) args[0]);
                    }
                    return method.getReturnType() == boolean.class ? Boolean.FALSE : null;
                });
        ApplicationManager.setApplication(application);
        try {
            HandlerContext context = new HandlerContext(
                    null, null, null, null,
                    new HandlerContext.JsCallback() {
                        @Override
                        public void callJavaScript(String functionName, String... args) {
                            jsCalls.incrementAndGet();
                        }

                        @Override
                        public String escapeJs(String str) {
                            return str;
                        }
                    });
            context.setDisposed(true);

            CodexPlanUsageHandler handler = new CodexPlanUsageHandler(context);
            assertTrue(handler.handle(CodexPlanUsageHandler.DISPATCH_TYPE, "42"));
            assertEquals(0, queued.size());
            assertEquals(0, jsCalls.get());
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }

    @Test
    public void skipsProbeAndCallbackWhenContextDisposedConcurrentlyInPooledThread() {
        AtomicInteger jsCalls = new AtomicInteger(0);
        List<Runnable> queued = new ArrayList<>();
        Application previous = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(
                Application.class.getClassLoader(),
                new Class<?>[]{Application.class},
                (proxy, method, args) -> {
                    if ("executeOnPooledThread".equals(method.getName())) {
                        queued.add((Runnable) args[0]);
                    }
                    return method.getReturnType() == boolean.class ? Boolean.FALSE : null;
                });
        ApplicationManager.setApplication(application);
        try {
            HandlerContext context = new HandlerContext(
                    null, null, null, null,
                    new HandlerContext.JsCallback() {
                        @Override
                        public void callJavaScript(String functionName, String... args) {
                            jsCalls.incrementAndGet();
                        }

                        @Override
                        public String escapeJs(String str) {
                            return str;
                        }
                    });
            CodexPlanUsageHandler handler = new CodexPlanUsageHandler(context);
            assertTrue(handler.handle(CodexPlanUsageHandler.DISPATCH_TYPE, "99"));
            assertEquals(1, queued.size());

            context.setDisposed(true);
            queued.get(0).run();
            assertEquals(0, jsCalls.get());
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }

    @Test
    public void echoesRequestIdWhenPushingFallbackPayload() {
        AtomicReference<String> callbackFn = new AtomicReference<>();
        AtomicReference<String> callbackPayload = new AtomicReference<>();
        List<Runnable> queued = new ArrayList<>();
        Application previous = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(
                Application.class.getClassLoader(),
                new Class<?>[]{Application.class},
                (proxy, method, args) -> {
                    if ("executeOnPooledThread".equals(method.getName())) {
                        queued.add((Runnable) args[0]);
                    }
                    return method.getReturnType() == boolean.class ? Boolean.FALSE : null;
                });
        ApplicationManager.setApplication(application);
        try {
            HandlerContext context = new HandlerContext(
                    null, null, null, null,
                    new HandlerContext.JsCallback() {
                        @Override
                        public void callJavaScript(String functionName, String... args) {
                            callbackFn.set(functionName);
                            callbackPayload.set(args != null && args.length > 0 ? args[0] : null);
                        }

                        @Override
                        public String escapeJs(String str) {
                            return str;
                        }
                    });

            CodexPlanUsageHandler handler = new CodexPlanUsageHandler(context);
            assertTrue(handler.handle(CodexPlanUsageHandler.DISPATCH_TYPE, "77"));
            assertEquals(1, queued.size());
            queued.get(0).run();

            assertEquals("window.updateCodexPlanUsage", callbackFn.get());
            assertNotNull(callbackPayload.get());
            JsonObject parsed = JsonParser.parseString(callbackPayload.get()).getAsJsonObject();
            assertEquals("77", parsed.get("request_id").getAsString());
            assertFalse(parsed.get("present").getAsBoolean());
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }
}
