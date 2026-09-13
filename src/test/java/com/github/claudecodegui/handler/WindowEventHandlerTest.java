package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for window-level bridge event dispatch, including the restored-history DOM commit
 * acknowledgment used to start native JCEF frame publication and tokenized surface-damage
 * phase acknowledgments that causally gate OSR paint handling.
 */
public class WindowEventHandlerTest {

    /** Verifies that history_dom_committed is supported and dispatched exactly once. */
    @Test
    public void dispatchesHistoryDomCommittedCallback() {
        AtomicReference<Long> historyCommitEpoch = new AtomicReference<>();
        HandlerContext context = new HandlerContext(null, null, null, null, new NoOpJsCallback());
        WindowEventHandler handler = new WindowEventHandler(context, new NoOpCallback() {
            @Override
            public void onHistoryRenderComplete(long commitEpoch) {
                historyCommitEpoch.set(commitEpoch);
            }
        });

        assertTrue(handler.handle("history_dom_committed", "7"));
        assertEquals(Long.valueOf(7L), historyCommitEpoch.get());
    }

    /** Verifies that a tokenized surface phase acknowledgment is parsed without losing identity. */
    @Test
    public void dispatchesSurfaceDamageAppliedCallback() {
        AtomicReference<String> observed = new AtomicReference<>();
        HandlerContext context = new HandlerContext(null, null, null, null, new NoOpJsCallback());
        WindowEventHandler handler = new WindowEventHandler(context, new NoOpCallback() {
            @Override
            public void onSurfaceDamageApplied(String token, String phase, boolean applied) {
                observed.set(token + ":" + phase + ":" + applied);
            }
        });

        assertTrue(handler.handle(
                "surface_damage_applied",
                "{\"token\":\"4:5:6:7\",\"phase\":\"B\",\"applied\":true}"));
        assertEquals("4:5:6:7:B:true", observed.get());
    }

    /** No-op JavaScript collaborator used by the handler context in this isolated dispatch test. */
    private static final class NoOpJsCallback implements HandlerContext.JsCallback {
        @Override
        public void callJavaScript(String functionName, String... args) {
            // No JavaScript calls are expected from a window event dispatch.
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }
    }

    /** Callback adapter that keeps unrelated window events inert for focused event tests. */
    private static class NoOpCallback implements WindowEventHandler.Callback {
        @Override public void onHeartbeat(String content) { }
        @Override public void onTabLoadingChanged(boolean loading) { }
        @Override public void onTabStatusChanged(String status) { }
        @Override public void onCreateNewSession() { }
        @Override public void onFrontendReady() { }
        @Override public void onHistoryRenderComplete(long commitEpoch) { }
        @Override public void onSurfaceDamageApplied(
                String token,
                String phase,
                boolean applied
        ) { }
        @Override public void onRefreshSlashCommands() { }
    }
}
