package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

/**
 * Story 007 AC-2: Verifies that {@link ProjectConfigHandler#handleSetGeminiIdleReapMinutes(String)}
 * clamps numeric values as long/double into [0, 1440] and rounds positive fractions (0, 1) up to 1
 * before casting to int and passing to {@link CodemossSettingsService#setGeminiIdleReapMinutes(int)}.
 */
public class ProjectConfigHandlerGeminiIdleReapTest {

    @Test
    public void shouldClampValuesAboveMaxTo1440() throws Exception {
        FakeSettingsService fakeService = new FakeSettingsService();
        CapturingJsCallback callback = new CapturingJsCallback();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(fakeService, callback), Runnable::run);

        handler.handleSetGeminiIdleReapMinutes("{\"geminiIdleReapMinutes\": 50000}");

        assertEquals("values above 1440 must be clamped to 1440",
                1440, fakeService.lastRequestedMinutes);
        assertPushedMinutes(1440, callback);
    }

    @Test
    public void shouldRoundPositiveFractionsInZeroToOneUpToOne() throws Exception {
        FakeSettingsService fakeService = new FakeSettingsService();
        CapturingJsCallback callback = new CapturingJsCallback();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(fakeService, callback), Runnable::run);

        handler.handleSetGeminiIdleReapMinutes("{\"geminiIdleReapMinutes\": 0.5}");

        assertEquals("fractions in (0, 1) must round up to 1 to avoid silently disabling watchdog",
                1, fakeService.lastRequestedMinutes);
        assertPushedMinutes(1, callback);
    }

    @Test
    public void shouldClampLargeNumbersExceedingIntegerMaxTo1440() throws Exception {
        FakeSettingsService fakeService = new FakeSettingsService();
        CapturingJsCallback callback = new CapturingJsCallback();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(fakeService, callback), Runnable::run);

        handler.handleSetGeminiIdleReapMinutes("{\"geminiIdleReapMinutes\": 3000000000}");

        assertEquals("values exceeding Integer.MAX_VALUE must be parsed safely and clamped to 1440",
                1440, fakeService.lastRequestedMinutes);
        assertPushedMinutes(1440, callback);
    }

    @Test
    public void shouldClampNegativeValuesToDisabledZero() throws Exception {
        FakeSettingsService fakeService = new FakeSettingsService();
        CapturingJsCallback callback = new CapturingJsCallback();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(fakeService, callback), Runnable::run);

        handler.handleSetGeminiIdleReapMinutes("{\"geminiIdleReapMinutes\": -5}");

        assertEquals("negative values must clamp to 0",
                0, fakeService.lastRequestedMinutes);
        assertPushedMinutes(0, callback);
    }

    @Test
    public void shouldLeaveZeroAsDisabled() throws Exception {
        FakeSettingsService fakeService = new FakeSettingsService();
        CapturingJsCallback callback = new CapturingJsCallback();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(fakeService, callback), Runnable::run);

        handler.handleSetGeminiIdleReapMinutes("{\"geminiIdleReapMinutes\": 0}");

        assertEquals("0 disables the watchdog and must remain 0",
                0, fakeService.lastRequestedMinutes);
        assertPushedMinutes(0, callback);
    }

    private void assertPushedMinutes(int expected, CapturingJsCallback callback) {
        assertEquals("window.updateGeminiIdleReapMinutes", callback.lastFunctionName);
        assertNotNull(callback.lastArg);
        JsonObject parsed = JsonParser.parseString(callback.lastArg).getAsJsonObject();
        assertEquals(expected, parsed.get("geminiIdleReapMinutes").getAsInt());
    }

    private HandlerContext contextWith(CodemossSettingsService settingsService,
                                       HandlerContext.JsCallback callback) {
        return new HandlerContext(
                null,
                null,
                null,
                settingsService,
                callback
        );
    }

    private static class CapturingJsCallback implements HandlerContext.JsCallback {
        private String lastFunctionName;
        private String lastArg;

        @Override
        public void callJavaScript(String functionName, String... args) {
            this.lastFunctionName = functionName;
            this.lastArg = (args != null && args.length > 0) ? args[0] : null;
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }
    }

    private static class FakeSettingsService extends CodemossSettingsService {
        private int lastRequestedMinutes = -1;
        private int effectiveMinutes = CodemossSettingsService.DEFAULT_GEMINI_IDLE_REAP_MINUTES;

        @Override
        public void setGeminiIdleReapMinutes(int minutes) throws IOException {
            this.lastRequestedMinutes = minutes;
            this.effectiveMinutes = Math.max(0, Math.min(1440, minutes));
        }

        @Override
        public int getGeminiIdleReapMinutes() throws IOException {
            return effectiveMinutes;
        }
    }
}
