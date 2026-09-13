package com.github.claudecodegui.util;

import com.intellij.ui.jcef.JBCefOSRHandlerFactory;
import org.cef.handler.CefKeyboardHandler;
import org.junit.Assert;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Tests browser-builder compatibility gates and keyboard/JCEF support helpers without creating a
 * live browser process.
 */
public class JBCefBrowserFactoryTest {

    /** Verifies control characters are suppressed outside editable fields. */
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

    /** Verifies editable fields retain control-character input for editor shortcuts. */
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

    /** Verifies non-character keyboard events bypass the control-character filter. */
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

    /** Verifies zero-valued characters with a control key code are also suppressed. */
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

    /** Verifies ordinary printable characters are never suppressed. */
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

    /** Mimics a newer JCEF browser implementation that exposes isClosed(). */
    public static class BrowserWithClosedApi {
        public boolean isClosed() {
            return false;
        }
    }

    /** Mimics a 233-era JCEF browser implementation without isClosed(). */
    public static class BrowserWithoutClosedApi {
    }

    /** Records builder options so Remote-forced OSR wiring can be tested without JCEF startup. */
    private static final class RecordingBuilderOptions {
        private boolean offScreenRendering;
        private boolean devToolsEnabled;
        private JBCefOSRHandlerFactory osrHandlerFactory;

        private void setOffScreenRendering(boolean value) {
            offScreenRendering = value;
        }

        private void setEnableOpenDevToolsMenuItem(boolean value) {
            devToolsEnabled = value;
        }

        private void setOSRHandlerFactory(JBCefOSRHandlerFactory value) {
            osrHandlerFactory = value;
        }
    }

    /** Verifies a supplied fence factory is installed even when the requested mode is windowed. */
    @Test
    public void installsOsrFactoryBeforeRemoteCanOverrideWindowedMode() {
        RecordingBuilderOptions builder = new RecordingBuilderOptions();
        JBCefOSRHandlerFactory factory = new JBCefOSRHandlerFactory() { };

        JBCefBrowserFactory.applyBuilderOptions(
                false,
                true,
                factory,
                builder::setOffScreenRendering,
                builder::setEnableOpenDevToolsMenuItem,
                builder::setOSRHandlerFactory);

        Assert.assertFalse(builder.offScreenRendering);
        Assert.assertTrue(builder.devToolsEnabled);
        Assert.assertSame(factory, builder.osrHandlerFactory);
    }

    /** Verifies no default factory is fabricated when callers do not request a wrapper. */
    @Test
    public void leavesOsrFactoryUnsetWhenNoCustomFactoryWasRequested() {
        RecordingBuilderOptions builder = new RecordingBuilderOptions();

        JBCefBrowserFactory.applyBuilderOptions(
                true,
                false,
                null,
                builder::setOffScreenRendering,
                builder::setEnableOpenDevToolsMenuItem,
                builder::setOSRHandlerFactory);

        Assert.assertTrue(builder.offScreenRendering);
        Assert.assertFalse(builder.devToolsEnabled);
        Assert.assertNull(builder.osrHandlerFactory);
    }

    /** Verifies the optional browser-closed API is discovered on newer runtimes. */
    @Test
    public void findsOptionalBrowserClosedApiWhenPresent() {
        Assert.assertTrue(JBCefBrowserFactory.findIsClosedMethod(BrowserWithClosedApi.class).isPresent());
    }

    /** Verifies older runtimes without the browser-closed API remain supported. */
    @Test
    public void toleratesBrowserClosedApiMissingOnOlderPlatforms() {
        Assert.assertTrue(JBCefBrowserFactory.findIsClosedMethod(BrowserWithoutClosedApi.class).isEmpty());
    }

    /** Verifies pre-2026 platform builds do not require the Remote JCEF API. */
    @Test
    public void remoteApiNotRequiredOnPlatformsBefore2026() {
        Assert.assertFalse(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(233));
        Assert.assertFalse(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(243));
        Assert.assertFalse(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(253));
    }

    /** Verifies 2026+ platform builds require the Remote JCEF API contract. */
    @Test
    public void remoteApiRequiredSincePlatform2026() {
        // Android Studio Quail 2026.1.1 = AI-261.x
        Assert.assertTrue(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(261));
        Assert.assertTrue(JBCefBrowserFactory.isRemoteApiRequiredByPlatform(262));
    }

    /** Verifies a compatible JBR exposes the Remote JCEF API. */
    @Test
    public void detectsRemoteApiWhenPresent() {
        Assert.assertTrue(JBCefBrowserFactory.hasJcefRemoteApi(JcefConfigWithRemoteApi.class));
    }

    /** Verifies an incompatible JBR without the Remote API is detected. */
    @Test
    public void detectsMissingRemoteApi() {
        Assert.assertFalse(JBCefBrowserFactory.hasJcefRemoteApi(JcefConfigWithoutRemoteApi.class));
    }

    /** Verifies registry disablement short-circuits all deeper support probes. */
    @Test
    public void disabledRegistryShortCircuitsPlatformSupportCheck() {
        AtomicBoolean platformChecked = new AtomicBoolean(false);
        AtomicBoolean remoteApiChecked = new AtomicBoolean(false);
        AtomicBoolean pluginChecked = new AtomicBoolean(false);

        JBCefBrowserFactory.JcefSupportStatus status = JBCefBrowserFactory.determineJcefSupport(
                false,
                () -> platformChecked.getAndSet(true),
                () -> remoteApiChecked.getAndSet(true),
                () -> pluginChecked.getAndSet(true)
        );

        Assert.assertEquals(JBCefBrowserFactory.JcefSupportStatus.DISABLED_BY_REGISTRY, status);
        Assert.assertFalse(platformChecked.get());
        Assert.assertFalse(remoteApiChecked.get());
        Assert.assertFalse(pluginChecked.get());
    }

    /** Verifies a supported platform does not require Android Studio's standalone plugin. */
    @Test
    public void platformSupportDoesNotRequireStandaloneJcefPlugin() {
        AtomicBoolean pluginChecked = new AtomicBoolean(false);

        JBCefBrowserFactory.JcefSupportStatus status = JBCefBrowserFactory.determineJcefSupport(
                true,
                () -> true,
                () -> false,
                () -> {
                    pluginChecked.set(true);
                    return true;
                }
        );

        Assert.assertEquals(JBCefBrowserFactory.JcefSupportStatus.SUPPORTED, status);
        Assert.assertFalse(pluginChecked.get());
    }

    /** Verifies Android Studio's missing standalone JCEF plugin is reported precisely. */
    @Test
    public void reportsMissingAndroidStudioJcefPlugin() {
        JBCefBrowserFactory.JcefSupportStatus status = JBCefBrowserFactory.determineJcefSupport(
                true,
                () -> false,
                () -> false,
                () -> true
        );

        Assert.assertEquals(JBCefBrowserFactory.JcefSupportStatus.ANDROID_STUDIO_PLUGIN_MISSING, status);
    }

    /** Verifies an outdated JBR is reported after the platform support probe succeeds. */
    @Test
    public void reportsOutdatedJbrAfterPlatformSupportCheck() {
        JBCefBrowserFactory.JcefSupportStatus status = JBCefBrowserFactory.determineJcefSupport(
                true,
                () -> true,
                () -> true,
                () -> false
        );

        Assert.assertEquals(JBCefBrowserFactory.JcefSupportStatus.OUTDATED_JBR, status);
    }

    /** Verifies platform-level JCEF rejection is reported as unavailable. */
    @Test
    public void reportsUnavailableWhenPlatformRejectsJcef() {
        JBCefBrowserFactory.JcefSupportStatus status = JBCefBrowserFactory.determineJcefSupport(
                true,
                () -> false,
                () -> false,
                () -> false
        );

        Assert.assertEquals(JBCefBrowserFactory.JcefSupportStatus.UNAVAILABLE, status);
    }

    /** Verifies compatible platform and runtime inputs produce supported status. */
    @Test
    public void reportsSupportedJcef() {
        JBCefBrowserFactory.JcefSupportStatus status = JBCefBrowserFactory.determineJcefSupport(
                true,
                () -> true,
                () -> false,
                () -> false
        );

        Assert.assertEquals(JBCefBrowserFactory.JcefSupportStatus.SUPPORTED, status);
    }
}
