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
    static final int HIDDEN_FRAME_RATE = 1;
    /** Chromium's upper bound for windowless rendering. */
    static final int MAX_FRAME_RATE = 60;
    static final String FRAME_RATE_REGISTRY_KEY = "ide.browser.jcef.osr.framerate";

    private final BooleanSupplier showing;
    private final IntConsumer frameRateSetter;
    private final int visibleFrameRate;

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
            CefBrowser cefBrowser = browser.getCefBrowser();
            if (JBCefBrowserFactory.isRemoteDevelopmentBrowser(cefBrowser)) {
                return;
            }
            Component component = browser.getComponent();
            OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(
                    component::isShowing,
                    rate -> setFrameRate(cefBrowser, rate),
                    Registry.intValue(FRAME_RATE_REGISTRY_KEY, 0));
            component.addHierarchyListener(event -> {
                if ((event.getChangeFlags() & HierarchyEvent.SHOWING_CHANGED) != 0) {
                    limiter.apply();
                }
            });
            // The in-process browser ignores the rate until its native peer exists.
            browser.getJBCefClient().addLifeSpanHandler(new CefLifeSpanHandlerAdapter() {
                @Override
                public void onAfterCreated(CefBrowser target) {
                    ApplicationManager.getApplication().invokeLater(limiter::apply, ModalityState.any());
                }
            }, cefBrowser);
            limiter.apply();
        } catch (RuntimeException | LinkageError e) {
            LOG.warn("Could not install the OSR frame-rate limiter; hidden browsers render at the full rate", e);
        }
    }

    /** Applies the rate for the browser's current on-screen state. */
    void apply() {
        frameRateSetter.accept(showing.getAsBoolean() ? visibleFrameRate : HIDDEN_FRAME_RATE);
    }

    /** A positive registry value is the user's choice; 0, the IDE default, means CEF's default. */
    static int visibleFrameRate(int registryFrameRate) {
        if (registryFrameRate <= 0) {
            return DEFAULT_FRAME_RATE;
        }
        return Math.min(registryFrameRate, MAX_FRAME_RATE);
    }

    private static void setFrameRate(CefBrowser cefBrowser, int rate) {
        if (JBCefBrowserFactory.isBrowserClosed(cefBrowser)) {
            return;
        }
        try {
            cefBrowser.setWindowlessFrameRate(rate);
        } catch (RuntimeException | LinkageError e) {
            LOG.debug("Failed to set the OSR frame rate to " + rate, e);
        }
    }
}
