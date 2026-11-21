package com.github.claudecodegui.util;

import org.junit.After;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SystemNotificationServiceTest {

    @After
    public void tearDown() {
        SystemNotificationService.resetTestHooks();
    }

    @Test
    public void shouldDisplayWhenFeatureIsEnabledAndFocusGateIsDisabled() {
        SystemNotificationService.setSystemNotificationOnlyWhenUnfocusedProvider(() -> false);
        SystemNotificationService.setIdeFocusedProvider(() -> true);

        assertTrue(SystemNotificationService.getInstance().shouldDisplayNotification(true));
    }

    @Test
    public void shouldSkipWhenOnlyWhenUnfocusedIsEnabledAndIdeIsActive() {
        SystemNotificationService.setSystemNotificationOnlyWhenUnfocusedProvider(() -> true);
        SystemNotificationService.setIdeFocusedProvider(() -> true);

        assertFalse(SystemNotificationService.getInstance().shouldDisplayNotification(true));
    }

    @Test
    public void shouldDisplayWhenOnlyWhenUnfocusedIsEnabledAndIdeIsInactive() {
        SystemNotificationService.setSystemNotificationOnlyWhenUnfocusedProvider(() -> true);
        SystemNotificationService.setIdeFocusedProvider(() -> false);

        assertTrue(SystemNotificationService.getInstance().shouldDisplayNotification(true));
    }

    @Test
    public void shouldSkipWhenFeatureIsDisabled() {
        SystemNotificationService.setSystemNotificationOnlyWhenUnfocusedProvider(() -> false);
        SystemNotificationService.setIdeFocusedProvider(() -> false);

        assertFalse(SystemNotificationService.getInstance().shouldDisplayNotification(false));
    }

    @Test
    public void tabCaptionIsOmittedWithoutASourceTab() {
        SystemNotificationService service = SystemNotificationService.getInstance();

        assertNull(service.resolveTabCaption(null));
        assertNull(service.resolveTabCaption(new NotificationSource(null, () -> { })));
        assertNull(service.resolveTabCaption(new NotificationSource("   ", () -> { })));
    }

    @Test
    public void tabCaptionKeepsTheNameAsPlainText() {
        SystemNotificationService service = SystemNotificationService.getInstance();

        assertEquals("AI2", service.resolveTabCaption(new NotificationSource("  AI2  ", null)));
        // The caption label has HTML rendering disabled, so the name must not be escaped.
        assertEquals("Fix <List> & co", service.resolveTabCaption(new NotificationSource("Fix <List> & co", null)));
    }

    @Test
    public void tabCaptionTruncatesLongNamesByCodePoint() {
        SystemNotificationService service = SystemNotificationService.getInstance();
        String longName = "🚀".repeat(50);

        String caption = service.resolveTabCaption(new NotificationSource(longName, null));

        assertEquals(40, caption.codePointCount(0, caption.length()));
        assertEquals("🚀".repeat(37) + "...", caption);
    }

    @Test
    public void focusSourceTabRunsTheFocusAction() {
        AtomicInteger calls = new AtomicInteger();

        SystemNotificationService.getInstance()
            .focusSourceTab(new NotificationSource("AI1", calls::incrementAndGet));

        assertEquals(1, calls.get());
    }

    @Test
    public void focusSourceTabIgnoresMissingActionsAndSwallowsFailures() {
        SystemNotificationService service = SystemNotificationService.getInstance();

        service.focusSourceTab(null);
        service.focusSourceTab(new NotificationSource("AI1", null));
        service.focusSourceTab(new NotificationSource("AI1", () -> {
            throw new IllegalStateException("tab was closed");
        }));
    }
}
