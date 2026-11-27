package com.github.claudecodegui.util;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.registry.Registry;
import com.intellij.ui.jcef.JBCefBrowser;
import org.cef.browser.CefBrowser;
import org.cef.handler.CefLifeSpanHandlerAdapter;

import java.awt.Component;
import java.awt.event.HierarchyEvent;
import java.lang.reflect.Method;
import java.util.function.BooleanSupplier;
import java.util.function.IntConsumer;

/**
 * Throttles an off-screen-rendered (OSR) browser while it is not on screen.
 *
 * <p>JCEF never tells an OSR browser that it was hidden, so a chat in a background tab or a
 * hidden tool window keeps rendering every animation frame (spinners, streaming text) at the
 * full windowless rate, and each frame is still transferred to the IDE. Off screen the browser
 * drops to {@value #HIDDEN_FRAME_RATE} fps; on screen it gets CEF's default of
 * {@value #DEFAULT_FRAME_RATE} fps, or the user's {@value #FRAME_RATE_REGISTRY_KEY} value. The
 * page stays visible to JavaScript, so timers, heartbeats and the render watchdog behave as
 * before.</p>
 */
final class OsrFrameRateLimiter {

    private static final Logger LOG = Logger.getInstance(OsrFrameRateLimiter.class);

    /** CEF's default for windowless browsers, used when the registry value is 0. */
    static final int DEFAULT_FRAME_RATE = 30;
    /**
     * A rate change waits for the frame tick already scheduled at the old rate, so the hidden rate
     * also bounds how long a browser that comes back on screen shows its last frame (200 ms here).
     */
    static final int HIDDEN_FRAME_RATE = 5;
    static final String FRAME_RATE_REGISTRY_KEY = "ide.browser.jcef.osr.framerate";

    private final BooleanSupplier showing;
    private final IntConsumer frameRateSetter;
    private final int visibleFrameRate;
    /** Read and written on the EDT only. */
    private boolean peerCreated;

    OsrFrameRateLimiter(BooleanSupplier showing, IntConsumer frameRateSetter, int registryFrameRate) {
        this.showing = showing;
        this.frameRateSetter = frameRateSetter;
        this.visibleFrameRate = visibleFrameRate(registryFrameRate);
    }

    /** Installs the limiter on an OSR browser; never throws, since it only saves CPU. */
    static void install(JBCefBrowser browser) {
        try {
            if (!browser.isOffScreenRendering()) {
                return;
            }
            Method setter = findFrameRateSetter();
            if (setter == null) {
                return;
            }
            CefBrowser cefBrowser = browser.getCefBrowser();
            if (JBCefBrowserFactory.isRemoteDevelopmentBrowser(cefBrowser)) {
                return;
            }
            Component component = browser.getComponent();
            OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(
                    component::isShowing,
                    rate -> setFrameRate(cefBrowser, setter, rate),
                    Registry.intValue(FRAME_RATE_REGISTRY_KEY, 0));
            component.addHierarchyListener(event -> limiter.onHierarchyChanged(event.getChangeFlags()));
            // Before its native peer exists the in-process browser drops the call and logs a CEF error.
            browser.getJBCefClient().addLifeSpanHandler(new CefLifeSpanHandlerAdapter() {
                @Override
                public void onAfterCreated(CefBrowser target) {
                    ApplicationManager.getApplication().invokeLater(limiter::onPeerCreated, ModalityState.any());
                }
            }, cefBrowser);
        } catch (RuntimeException | LinkageError e) {
            LOG.warn("Could not install the OSR frame-rate limiter; hidden browsers render at the full rate", e);
        }
    }

    /** Called once the native browser exists; applies the rate for the current on-screen state. */
    void onPeerCreated() {
        peerCreated = true;
        apply();
    }

    /** Re-applies the rate when the browser component starts or stops showing. */
    void onHierarchyChanged(long changeFlags) {
        if ((changeFlags & HierarchyEvent.SHOWING_CHANGED) != 0) {
            apply();
        }
    }

    private void apply() {
        if (peerCreated) {
            frameRateSetter.accept(showing.getAsBoolean() ? visibleFrameRate : HIDDEN_FRAME_RATE);
        }
    }

    /**
     * A positive registry value is the user's choice and is passed on as is, like the platform does:
     * CEF has no upper limit for windowless rendering. 0, the IDE default, means CEF's default.
     */
    static int visibleFrameRate(int registryFrameRate) {
        return registryFrameRate > 0 ? registryFrameRate : DEFAULT_FRAME_RATE;
    }

    /**
     * Looked up reflectively: 2023.3 (233) JCEF has no setWindowlessFrameRate, and a direct call
     * makes the Marketplace plugin verifier report the plugin as binary incompatible with 233.
     */
    static Method findFrameRateSetter() {
        try {
            return CefBrowser.class.getMethod("setWindowlessFrameRate", int.class);
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    private static void setFrameRate(CefBrowser cefBrowser, Method setter, int rate) {
        if (JBCefBrowserFactory.isBrowserClosed(cefBrowser)) {
            return;
        }
        try {
            setter.invoke(cefBrowser, rate);
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOG.debug("Failed to set the OSR frame rate to " + rate, e);
        }
    }
}
