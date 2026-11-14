package com.github.claudecodegui.handler.provider.gemini;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Contract-pins the plan-usage bridge wiring (review M1): the dispatch type the
 * webview polls and the JS callback the snapshot is pushed through are string
 * contracts across the Java/webview boundary — a rename or typo would silently
 * kill the indicator while both suites stay green. Precedent:
 * {@link CodexMcpServerHandlerCallbackTest}.
 */
public class GeminiPlanUsageHandlerCallbackTest {

    @Test
    public void geminiPlanUsagePushesThroughTheContractedJsCallback() {
        assertEquals(
                "window.updateGeminiPlanUsage",
                GeminiPlanUsageHandler.GEMINI_PLAN_USAGE_CALLBACK);
    }

    @Test
    public void geminiPlanUsageDispatchTypeMatchesTheWebviewPollCommand() {
        assertEquals("get_gemini_plan_usage", GeminiPlanUsageHandler.DISPATCH_TYPE);
        assertArrayEquals(
                "the supported types must expose exactly the contracted dispatch type",
                new String[]{GeminiPlanUsageHandler.DISPATCH_TYPE},
                new GeminiPlanUsageHandler(null).getSupportedTypes());
    }

    @Test
    public void unknownDispatchTypeIsRejectedWithoutTouchingTheContext() {
        assertFalse(new GeminiPlanUsageHandler(null).handle("get_claude_plan_usage", null));
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

            GeminiPlanUsageHandler handler = new GeminiPlanUsageHandler(context);
            boolean handled = handler.handle(GeminiPlanUsageHandler.DISPATCH_TYPE, "gemini-3.7-flash-high");
            assertTrue("handler must handle the dispatch type", handled);
            assertEquals("must not execute on pooled thread when context is disposed", 0, queued.size());
            assertEquals("must not invoke JS callback when context is disposed", 0, jsCalls.get());
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
            GeminiPlanUsageHandler handler = new GeminiPlanUsageHandler(context);
            boolean handled = handler.handle(GeminiPlanUsageHandler.DISPATCH_TYPE, "gemini-3.7-flash-high");
            assertTrue(handled);
            assertEquals(1, queued.size());

            // Disposed before the queued background task executes
            context.setDisposed(true);
            queued.get(0).run();

            assertEquals("must skip probe and JS callback when context is disposed in background thread", 0, jsCalls.get());
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }
}

