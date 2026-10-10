package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.ui.toolwindow.MessageDispatchGate;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClawBotStatusHandlerTest {

    @Test
    public void blockedStatusDoesNotHoldDispatchGateForRecoveryOrTeardown() throws Exception {
        AtomicReference<String> published = new AtomicReference<>();
        HandlerContext context = context(published);
        MessageDispatchGate gate = new MessageDispatchGate();
        CountDownLatch snapshotStarted = new CountDownLatch(1);
        CountDownLatch releaseSnapshot = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(3);
        try {
            ClawBotStatusHandler handler = new ClawBotStatusHandler(context, workers, Runnable::run, () -> {
                snapshotStarted.countDown();
                try {
                    if (!releaseSnapshot.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Snapshot release timed out");
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
                return new JsonObject();
            });
            java.util.concurrent.Future<Boolean> dispatch = workers.submit(
                    () -> gate.runInDispatch(() -> assertTrue(handler.handle("get_clawbot_status", ""))));
            assertTrue(snapshotStarted.await(5, TimeUnit.SECONDS));
            assertTrue(dispatch.get(5, TimeUnit.SECONDS));
            workers.submit(() -> gate.activatePageGeneration(1)).get(5, TimeUnit.SECONDS);
            assertTrue(workers.submit(gate::beginTeardown).get(5, TimeUnit.SECONDS));
            assertNull(published.get());
            context.setDisposed(true);
        } finally {
            releaseSnapshot.countDown();
            workers.shutdown();
            assertTrue(workers.awaitTermination(5, TimeUnit.SECONDS));
        }
        assertNull(published.get());
    }

    @Test
    public void statusIsPublishedOnlyOnScheduledUiCallback() {
        List<Runnable> background = new ArrayList<>();
        List<Runnable> ui = new ArrayList<>();
        AtomicReference<String> published = new AtomicReference<>();
        JsonObject status = new JsonObject();
        status.addProperty("state", "LEADER");
        ClawBotStatusHandler handler = new ClawBotStatusHandler(context(published), background::add, ui::add, () -> status);

        assertTrue(handler.handle("get_clawbot_status", ""));
        assertEquals(1, background.size());
        assertTrue(ui.isEmpty());
        assertNull(published.get());
        background.get(0).run();
        assertEquals(1, ui.size());
        assertNull(published.get());
        ui.get(0).run();
        assertEquals("LEADER", JsonParser.parseString(published.get()).getAsJsonObject().get("state").getAsString());
    }

    @Test
    public void disposalBeforeBackgroundWorkSkipsSnapshot() {
        List<Runnable> background = new ArrayList<>();
        List<Runnable> ui = new ArrayList<>();
        HandlerContext context = context(new AtomicReference<>());
        ClawBotStatusHandler handler = new ClawBotStatusHandler(context, background::add, ui::add, () -> {
            throw new AssertionError("Disposed handler must not query the gateway");
        });

        assertTrue(handler.handle("get_clawbot_status", ""));
        context.setDisposed(true);
        background.get(0).run();
        assertTrue(ui.isEmpty());
    }

    @Test
    public void disposalBeforeUiCallbackSuppressesLatePublication() {
        List<Runnable> ui = new ArrayList<>();
        AtomicReference<String> published = new AtomicReference<>();
        HandlerContext context = context(published);
        ClawBotStatusHandler handler = new ClawBotStatusHandler(context, Runnable::run, ui::add, JsonObject::new);

        assertTrue(handler.handle("get_clawbot_status", ""));
        context.setDisposed(true);
        ui.get(0).run();
        assertNull(published.get());
    }

    @Test
    public void unavailableSnapshotPublishesSanitizedStoppedStatus() {
        AtomicReference<String> published = new AtomicReference<>();
        ClawBotStatusHandler handler = new ClawBotStatusHandler(context(published), Runnable::run, Runnable::run, () -> {
            throw new IllegalStateException("unsafe-internal-detail");
        });

        assertTrue(handler.handle("get_clawbot_status", ""));
        JsonObject status = JsonParser.parseString(published.get()).getAsJsonObject();
        assertEquals("STOPPED", status.get("state").getAsString());
        assertEquals("BINDING_STATUS_UNAVAILABLE", status.get("bindingDiagnostic").getAsString());
        assertFalse(published.get().contains("unsafe-internal-detail"));
    }

    @Test
    public void unsupportedMessageDoesNotScheduleWork() {
        List<Runnable> background = new ArrayList<>();
        ClawBotStatusHandler handler = new ClawBotStatusHandler(context(new AtomicReference<>()),
                background::add, task -> { throw new AssertionError("Unexpected UI callback"); }, JsonObject::new);

        assertFalse(handler.handle("other_type", ""));
        assertTrue(background.isEmpty());
    }

    private static HandlerContext context(AtomicReference<String> published) {
        return new HandlerContext(null, null, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
                assertEquals("window.onClawBotStatus", functionName);
                published.set(args[0]);
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }
}
