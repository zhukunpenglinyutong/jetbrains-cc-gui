package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class HistoryHandlerRestoredHistoryTest {

    @Test
    public void routesManualLoadAndRequestSpecificCancellation() {
        HistoryHandler handler = new HistoryHandler(new HandlerContext(null, null, null, null, null));
        AtomicInteger loads = new AtomicInteger();
        AtomicReference<String> cancelledRequest = new AtomicReference<>();
        handler.setRestoredHistoryCallback(new HistoryHandler.RestoredHistoryCallback() {
            @Override
            public void onLoad() {
                loads.incrementAndGet();
            }

            @Override
            public void onCancel(String requestId) {
                cancelledRequest.set(requestId);
            }
        });

        assertTrue(handler.handle("load_restored_history", ""));
        assertTrue(handler.handle("cancel_restored_history", " request-7 "));
        assertEquals(1, loads.get());
        assertEquals("request-7", cancelledRequest.get());
    }

    @Test
    public void codexHistorySelectionRetiresThePendingRestoreBeforeRebindingInPlace() {
        Application previous = ApplicationManager.getApplication();
        ApplicationManager.setApplication((Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, arguments) -> null));
        try {
            HistoryHandler handler = new HistoryHandler(new HandlerContext(null, null, null, null, null));
            AtomicInteger codexSelections = new AtomicInteger();
            handler.setRestoredHistoryCallback(new HistoryHandler.RestoredHistoryCallback() {
                @Override
                public void onLoad() {
                }

                @Override
                public void onCancel(String requestId) {
                }

                @Override
                public void onCodexSessionSelected() {
                    codexSelections.incrementAndGet();
                }
            });

            handler.handle("load_session", "{\"sessionId\":\"claude-session\",\"provider\":\"claude\"}");
            assertEquals("Other providers retire through the session swap", 0, codexSelections.get());

            handler.handle("load_session", "{\"sessionId\":\"codex-thread\",\"provider\":\"codex\"}");
            assertEquals(1, codexSelections.get());
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }
}
