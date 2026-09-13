package com.github.claudecodegui.util;

import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
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
}
