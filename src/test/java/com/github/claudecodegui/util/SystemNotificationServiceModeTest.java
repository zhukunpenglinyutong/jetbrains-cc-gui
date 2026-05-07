package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SystemNotificationServiceModeTest {

    @Test
    public void ideNativeModeIsDefaultUnlessCardExplicitlySelected() {
        assertTrue(SystemNotificationService.isIdeNativeMode("ide-native"));
        assertTrue(SystemNotificationService.isIdeNativeMode(null));
        assertFalse(SystemNotificationService.isIdeNativeMode("card"));
    }

    @Test
    public void cardModeAlwaysUsesCardPopup() {
        assertTrue(SystemNotificationService.shouldAlsoShowCardPopup("card", true));
        assertTrue(SystemNotificationService.shouldAlsoShowCardPopup("card", false));
    }

    @Test
    public void ideNativeModeUsesCardPopupFallbackWhenIdeIsNotActive() {
        assertFalse(SystemNotificationService.shouldAlsoShowCardPopup("ide-native", true));
        assertTrue(SystemNotificationService.shouldAlsoShowCardPopup("ide-native", false));
    }
}
