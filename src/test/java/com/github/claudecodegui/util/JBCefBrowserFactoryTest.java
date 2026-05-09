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
}
