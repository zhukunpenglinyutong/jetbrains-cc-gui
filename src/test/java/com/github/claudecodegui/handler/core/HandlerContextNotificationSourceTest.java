package com.github.claudecodegui.handler.core;

import com.github.claudecodegui.util.NotificationSource;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class HandlerContextNotificationSourceTest {

    @Test
    public void notificationSourceNamesTheTabAndFocusesIt() {
        AtomicInteger activations = new AtomicInteger();
        HandlerContext context = newContext(() -> "AI3");
        context.setContentActivator(activations::incrementAndGet);

        NotificationSource source = context.notificationSource();

        assertEquals("AI3", source.tabName());
        assertNotNull(source.focusAction());
        source.focusAction().run();
        assertEquals(1, activations.get());
    }

    @Test
    public void notificationSourceReadsTheTabNameWhenCreated() {
        String[] title = {"AI1"};
        HandlerContext context = newContext(() -> title[0]);

        NotificationSource before = context.notificationSource();
        title[0] = "Renamed";

        assertEquals("AI1", before.tabName());
        assertEquals("Renamed", context.notificationSource().tabName());
    }

    @Test
    public void notificationSourceToleratesAFailingTitleSupplier() {
        HandlerContext context = newContext(() -> {
            throw new IllegalStateException("content already removed");
        });

        assertNull(context.notificationSource().tabName());
    }

    @Test
    public void focusActionDoesNothingOnceTheContextIsDisposed() {
        AtomicInteger activations = new AtomicInteger();
        HandlerContext context = newContext(() -> "AI1");
        context.setContentActivator(activations::incrementAndGet);
        NotificationSource source = context.notificationSource();

        context.setDisposed(true);
        source.focusAction().run();

        assertEquals(0, activations.get());
    }

    private static HandlerContext newContext(Supplier<String> titleSupplier) {
        return new HandlerContext(null, null, null, null, null, () -> true, titleSupplier);
    }
}
