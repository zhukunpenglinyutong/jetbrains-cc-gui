package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import org.junit.Test;

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
}
