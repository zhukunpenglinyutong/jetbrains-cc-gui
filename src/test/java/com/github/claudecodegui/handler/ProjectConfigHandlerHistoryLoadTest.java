package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ProjectConfigHandlerHistoryLoadTest {

    @Test
    public void historySettingsPushTheirEffectiveApplicationValues() {
        FakeSettingsService settingsService = new FakeSettingsService();
        AtomicReference<String> callback = new AtomicReference<>();
        AtomicReference<String> payload = new AtomicReference<>();
        AtomicReference<CountDownLatch> callbackLatch = new AtomicReference<>(new CountDownLatch(1));
        ProjectConfigHandler handler = new ProjectConfigHandler(new HandlerContext(
                null, null, null, settingsService, new HandlerContext.JsCallback() {
                    @Override
                    public void callJavaScript(String functionName, String... args) {
                        callback.set(functionName);
                        payload.set(args[0]);
                        callbackLatch.get().countDown();
                    }

                    @Override
                    public String escapeJs(String str) {
                        return str;
                    }
                }));

        handler.handleSetHistoryLoadTimeout("{\"historyLoadTimeoutSeconds\":999}");
        awaitCallback(callbackLatch.get());
        JsonObject timeout = JsonParser.parseString(payload.get()).getAsJsonObject();
        assertEquals("window.updateHistoryLoadTimeout", callback.get());
        assertEquals(120, settingsService.timeoutSeconds);
        assertEquals(120, timeout.get("historyLoadTimeoutSeconds").getAsInt());

        callbackLatch.set(new CountDownLatch(1));
        handler.handleSetLoadHistoryOnStartup("{\"loadHistoryOnStartup\":true}");
        awaitCallback(callbackLatch.get());
        JsonObject startup = JsonParser.parseString(payload.get()).getAsJsonObject();
        assertEquals("window.updateLoadHistoryOnStartup", callback.get());
        assertTrue(settingsService.loadOnStartup);
        assertTrue(startup.get("loadHistoryOnStartup").getAsBoolean());
    }

    @Test
    public void invalidHistoryLoadTimeoutDoesNotResetTheStoredValue() {
        FakeSettingsService settingsService = new FakeSettingsService();
        settingsService.timeoutSeconds = 45;
        AtomicReference<String> payload = new AtomicReference<>();
        CountDownLatch callbackLatch = new CountDownLatch(1);
        ProjectConfigHandler handler = new ProjectConfigHandler(new HandlerContext(
                null, null, null, settingsService, new HandlerContext.JsCallback() {
                    @Override
                    public void callJavaScript(String functionName, String... args) {
                        payload.set(args[0]);
                        callbackLatch.countDown();
                    }

                    @Override
                    public String escapeJs(String str) {
                        return str;
                    }
                }));

        handler.handleSetHistoryLoadTimeout("{}");
        awaitCallback(callbackLatch);

        assertEquals(45, settingsService.timeoutSeconds);
        assertEquals(45, JsonParser.parseString(payload.get()).getAsJsonObject()
                .get("historyLoadTimeoutSeconds").getAsInt());
    }

    private void awaitCallback(CountDownLatch callbackLatch) {
        try {
            assertTrue("Expected ProjectConfigHandler callback", callbackLatch.await(2, TimeUnit.SECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError("Interrupted while waiting for ProjectConfigHandler callback", e);
        }
    }

    private static final class FakeSettingsService extends CodemossSettingsService {
        private int timeoutSeconds = DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS;
        private boolean loadOnStartup;

        @Override
        public int getHistoryLoadTimeoutSeconds() {
            return timeoutSeconds;
        }

        @Override
        public void setHistoryLoadTimeoutSeconds(int seconds) {
            timeoutSeconds = clampHistoryLoadTimeoutSeconds(seconds);
        }

        @Override
        public boolean isLoadHistoryOnStartup() {
            return loadOnStartup;
        }

        @Override
        public void setLoadHistoryOnStartup(boolean enabled) {
            loadOnStartup = enabled;
        }
    }
}
