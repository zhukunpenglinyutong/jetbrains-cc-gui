package com.github.claudecodegui.util;

import org.cef.handler.CefKeyboardHandler;
import org.junit.Assert;
import org.junit.Test;

public class JBCefBrowserFactoryTest {

    @Test
    public void suppressesControlCharOnNonEditableField() {
        CefKeyboardHandler.CefKeyEvent event = new CefKeyboardHandler.CefKeyEvent(
                CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_CHAR,
                4,
                19,
                31,
                false,
                (char) 0x13,
                (char) 0x13,
                false
        );

        Assert.assertTrue(JBCefBrowserFactory.shouldSuppressProblematicCharEvent(event));
    }

    @Test
    public void keepsControlCharForEditableField() {
        CefKeyboardHandler.CefKeyEvent event = new CefKeyboardHandler.CefKeyEvent(
                CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_CHAR,
                4,
                19,
                31,
                false,
                (char) 0x13,
                (char) 0x13,
                true
        );

        Assert.assertFalse(JBCefBrowserFactory.shouldSuppressProblematicCharEvent(event));
    }

    @Test
    public void keepsNonCharEvents() {
        CefKeyboardHandler.CefKeyEvent event = new CefKeyboardHandler.CefKeyEvent(
                CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_KEYDOWN,
                4,
                19,
                31,
                false,
                (char) 0x13,
                (char) 0x13,
                false
        );

        Assert.assertFalse(JBCefBrowserFactory.shouldSuppressProblematicCharEvent(event));
    }

    @Test
    public void suppressesZeroCharOnNonEditableFieldWhenWindowsKeyCodeIsPresent() {
        CefKeyboardHandler.CefKeyEvent event = new CefKeyboardHandler.CefKeyEvent(
                CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_CHAR,
                4,
                4,
                32,
                false,
                (char) 0,
                (char) 0,
                false
        );

        Assert.assertTrue(JBCefBrowserFactory.shouldSuppressProblematicCharEvent(event));
    }

    @Test
    public void keepsPrintableChars() {
        CefKeyboardHandler.CefKeyEvent event = new CefKeyboardHandler.CefKeyEvent(
                CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_CHAR,
                0,
                65,
                65,
                false,
                'a',
                'a',
                false
        );

        Assert.assertFalse(JBCefBrowserFactory.shouldSuppressProblematicCharEvent(event));
    }

    // ---- JBR/JCEF remote API mismatch detection (Android Studio 2026.x) ----

    /** Mimics a modern JBR's JCefAppConfig that ships isRemoteEnabled(). */
    public static class JcefConfigWithRemoteApi {
        public boolean isRemoteEnabled() {
            return false;
        }
    }

    /** Mimics an outdated JBR's JCefAppConfig (pre-b1373, no isRemoteEnabled()). */
    public static class JcefConfigWithoutRemoteApi {
    }

    @Test
    public void remoteApiNotRequiredOnPlatformsBefore2026() {
        Assert.assertFalse(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(233));
        Assert.assertFalse(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(243));
        Assert.assertFalse(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(253));
    }

    @Test
    public void remoteApiRequiredSincePlatform2026() {
        // Android Studio Quail 2026.1.1 = AI-261.x
        Assert.assertTrue(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(261));
        Assert.assertTrue(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(262));
    }

    @Test
    public void detectsRemoteApiWhenPresent() {
        Assert.assertTrue(JBCefBrowserFactory.hasJcefRemoteApi(JcefConfigWithRemoteApi.class));
    }

    @Test
    public void detectsMissingRemoteApi() {
        Assert.assertFalse(JBCefBrowserFactory.hasJcefRemoteApi(JcefConfigWithoutRemoteApi.class));
    }
}
