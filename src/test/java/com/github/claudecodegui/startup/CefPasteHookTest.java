package com.github.claudecodegui.startup;

import org.cef.handler.CefKeyboardHandler.CefKeyEvent;
import org.cef.handler.CefKeyboardHandler.CefKeyEvent.EventType;
import org.cef.misc.EventFlags;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** Guards browser-scoped registration and orphan-key recovery without starting native CEF. */
public class CefPasteHookTest {

    /** Reloads and other tabs need independent registrations, but rebinding the same browser does not. */
    @Test
    public void registersEachBrowserOnlyOnce() {
        Object firstBrowser = new Object();
        Object secondBrowser = new Object();
        AtomicInteger registrations = new AtomicInteger();

        assertTrue(CefPasteHook.registerHook(firstBrowser, registrations::incrementAndGet));
        assertFalse(CefPasteHook.registerHook(firstBrowser, registrations::incrementAndGet));
        assertTrue(CefPasteHook.registerHook(secondBrowser, registrations::incrementAndGet));
        assertFalse(CefPasteHook.registerHook(null, registrations::incrementAndGet));
        assertEquals(2, registrations.get());
    }

    /** A failed attach cannot mark the browser installed and silently disable recovery forever. */
    @Test
    public void failedRegistrationCanRetry() {
        Object browser = new Object();
        AtomicInteger registrations = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> CefPasteHook.registerHook(browser, () -> {
            throw new IllegalStateException("client not ready");
        }));

        assertTrue(CefPasteHook.registerHook(browser, registrations::incrementAndGet));
        assertEquals(1, registrations.get());
    }

    /** Only an orphan Command+V keyup invokes the shared clipboard ownership path. */
    @Test
    public void recoversOrphanCommandPaste() {
        AtomicInteger captures = new AtomicInteger();
        CefPasteHook hook = new CefPasteHook(captures::incrementAndGet);

        assertFalse(hook.onPreKeyEvent(null, vKey(EventType.KEYEVENT_KEYUP, true), null));
        assertEquals(1, captures.get());
    }

    /** Normal DOM paste must not acquire another native snapshot for the same key gesture. */
    @Test
    public void matchingKeydownLeavesNormalPasteAlone() {
        AtomicInteger captures = new AtomicInteger();
        CefPasteHook hook = new CefPasteHook(captures::incrementAndGet);

        hook.onPreKeyEvent(null, vKey(EventType.KEYEVENT_RAWKEYDOWN, true), null);
        hook.onPreKeyEvent(null, vKey(EventType.KEYEVENT_KEYUP, true), null);
        assertEquals(0, captures.get());
    }

    /** Holding a bare V cannot paste an unrelated clipboard image. */
    @Test
    public void bareVNeverReadsTheClipboard() {
        AtomicInteger captures = new AtomicInteger();
        CefPasteHook hook = new CefPasteHook(captures::incrementAndGet);

        hook.onPreKeyEvent(null, vKey(EventType.KEYEVENT_KEYUP, false), null);
        assertEquals(0, captures.get());
    }

    private static CefKeyEvent vKey(EventType type, boolean commandDown) {
        return new CefKeyEvent(type, commandDown ? EventFlags.EVENTFLAG_COMMAND_DOWN : 0,
                0x56, 0, false, 'v', 'v', true);
    }
}
