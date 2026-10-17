package com.github.claudecodegui.startup;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.lang.reflect.Field;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.TimeUnit;

import org.cef.browser.CefBrowser;
import org.cef.handler.CefKeyboardHandler.CefKeyEvent.EventType;
import org.cef.handler.CefKeyboardHandlerAdapter;
import org.cef.misc.BoolRef;
import org.cef.misc.EventFlags;

/**
 * macOS 27 CEF remote quirk: Cmd+V keydown never reaches onPreKeyEvent as KEYEVENT_RAWKEYDOWN.
 * Only an orphan KEYEVENT_KEYUP (wkc=86) arrives.
 * Strategy: on KEYUP for V with Command still held, if no matching RAWKEYDOWN
 * for V was seen within 800ms, treat it as an intercepted Cmd+V and paste the
 * clipboard image.
 *
 * One hook per browser: installation is driven by ClaudeChatWindow.replaceBrowser
 * and registered through JBCefClient so it coexists with the platform's keyboard
 * handler. A single global install would leave second projects, extra tabs and
 * recreated browsers without the fix.
 */
public class CefPasteHook extends CefKeyboardHandlerAdapter {

    private static final Logger LOG = Logger.getInstance(CefPasteHook.class);
    private static final int VK_V = 0x56;
    private static final long ORPHAN_WINDOW_MS = 800;
    private static final long PASTE_DEBOUNCE_MS = 500;
    private static final int MAX_INSTALL_ATTEMPTS = 8;
    private static final long INSTALL_RETRY_DELAY_MS = 3000;

    /** Weak keys keep the registry from retaining disposed browsers and their windows. */
    private static final Set<Object> INSTALLED_BROWSERS = Collections.synchronizedSet(
            Collections.newSetFromMap(new WeakHashMap<>()));

    private volatile long lastVRawKeyDown = 0;
    private volatile long lastPasteTrigger = 0;
    private volatile boolean sawVRawKeyDown = false;

    private final Runnable captureClipboardPaste;

    CefPasteHook(Runnable captureClipboardPaste) {
        this.captureClipboardPaste = captureClipboardPaste;
    }

    /**
     * Attach the hook to the window's current browser, retrying briefly during initialization.
     * Safe to call on every browser (re)bind: each CefBrowser gets at most one hook.
     */
    public static void installForWindow(ClaudeChatWindow window) {
        installForWindow(window, 0);
    }

    private static void installForWindow(ClaudeChatWindow window, int attempt) {
        try {
            if (window == null || window.isDisposed()) {
                return;
            }
            JBCefBrowser browser = readBrowser(window);
            if (browser == null) {
                if (attempt < MAX_INSTALL_ATTEMPTS) {
                    AppExecutorUtil.getAppScheduledExecutorService().schedule(
                            () -> installForWindow(window, attempt + 1),
                            INSTALL_RETRY_DELAY_MS, TimeUnit.MILLISECONDS);
                } else {
                    LOG.info("[paste-fix][CEF] browser client not ready after "
                            + MAX_INSTALL_ATTEMPTS + " attempts, hook not installed");
                }
                return;
            }
            install(browser, window);
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] install error", t);
        }
    }

    /**
     * Install a browser-scoped keyboard hook alongside the platform's default handler.
     */
    public static void install(JBCefBrowser browser, ClaudeChatWindow window) {
        try {
            if (browser == null || browser.isDisposed() || window == null || window.isDisposed()) {
                return;
            }
            CefBrowser cefBrowser = browser.getCefBrowser();
            // Raw CefClient.addKeyboardHandler ignores a second handler. JBCefClient
            // multiplexes the existing platform handler and removes ours on browser close.
            if (registerHook(cefBrowser, () -> browser.getJBCefClient().addKeyboardHandler(
                    new CefPasteHook(window::captureClipboardPaste), cefBrowser))) {
                LOG.info("[paste-fix][CEF] CefPasteHook installed on browser " + System.identityHashCode(cefBrowser));
            }
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] install failed", t);
        }
    }

    static boolean registerHook(Object browserIdentity, Runnable registration) {
        // A failed registration must leave the browser eligible for a later retry.
        synchronized (INSTALLED_BROWSERS) {
            if (browserIdentity == null || INSTALLED_BROWSERS.contains(browserIdentity)) {
                return false;
            }
            registration.run();
            INSTALLED_BROWSERS.add(browserIdentity);
            return true;
        }
    }

    private static JBCefBrowser readBrowser(ClaudeChatWindow window) {
        try {
            Field f = ClaudeChatWindow.class.getDeclaredField("browser");
            f.setAccessible(true);
            Object v = f.get(window);
            return v instanceof JBCefBrowser ? (JBCefBrowser) v : null;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Recover intercepted image pastes through the frontend's draft ownership protocol.
     */
    @Override
    public boolean onPreKeyEvent(CefBrowser browser, CefKeyEvent event, BoolRef isKeyboardShortcut) {
        try {
            if (!isVKey(event)) {
                return false;
            }
            long now = System.currentTimeMillis();
            if (event.type == EventType.KEYEVENT_RAWKEYDOWN) {
                this.sawVRawKeyDown = true;
                this.lastVRawKeyDown = now;
                return false;
            }
            if (event.type != EventType.KEYEVENT_KEYUP) {
                return false;
            }

            // Orphan KEYUP: no RAWKEYDOWN recently => a Cmd+V whose keydown the OS
            // swallowed before CEF. Command must still be held: macOS press-and-hold
            // on a bare 'v' emits no autorepeat RAWKEYDOWN either, so without the
            // modifier check simply holding v past the window would paste whatever
            // image happens to be in the clipboard.
            boolean commandDown = (event.modifiers & EventFlags.EVENTFLAG_COMMAND_DOWN) != 0;
            boolean orphan = !(this.sawVRawKeyDown && (now - this.lastVRawKeyDown) < ORPHAN_WINDOW_MS);
            this.sawVRawKeyDown = false; // consume
            if (!orphan || !commandDown) {
                return false;
            }

            if (now - this.lastPasteTrigger < PASTE_DEBOUNCE_MS) {
                return false;
            }
            this.lastPasteTrigger = now;
            LOG.info("[paste-fix][CEF] orphan Cmd+V detected, pasting image");

            // Capture on the first EDT handoff so a JS round trip cannot substitute newer clipboard contents.
            this.captureClipboardPaste.run();
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] hook error", t);
        }
        return false;
    }

    /**
     * windows_key_code is the PHYSICAL key: on Dvorak and similar layouts Cmd+V
     * is not 0x56, so also accept the layout-translated characters.
     */
    private static boolean isVKey(CefKeyEvent event) {
        return event.windows_key_code == VK_V
                || event.character == 'v' || event.character == 'V'
                || event.unmodified_character == 'v' || event.unmodified_character == 'V';
    }

}
