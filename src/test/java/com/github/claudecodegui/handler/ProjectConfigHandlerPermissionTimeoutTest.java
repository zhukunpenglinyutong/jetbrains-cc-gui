package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;

import static org.junit.Assert.assertEquals;

public class ProjectConfigHandlerPermissionTimeoutTest {

    @Test
    public void setPermissionDialogTimeoutResponseUsesEffectiveClampedValue() throws Exception {
        FakeSettingsService settingsService = new FakeSettingsService();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(settingsService));

        JsonObject lowResponse = handler.setPermissionDialogTimeoutAndCreateResponse(
                "{\"permissionDialogTimeoutSeconds\":1}"
        );
        assertEquals(1, settingsService.lastRequestedSeconds);
        assertEquals(30, lowResponse.get("permissionDialogTimeoutSeconds").getAsInt());

        JsonObject highResponse = handler.setPermissionDialogTimeoutAndCreateResponse(
                "{\"permissionDialogTimeoutSeconds\":99999}"
        );
        assertEquals(99999, settingsService.lastRequestedSeconds);
        assertEquals(3600, highResponse.get("permissionDialogTimeoutSeconds").getAsInt());
    }

    @Test
    public void setPermissionDialogTimeoutDefaultsMissingValue() throws Exception {
        FakeSettingsService settingsService = new FakeSettingsService();
        ProjectConfigHandler handler = new ProjectConfigHandler(contextWith(settingsService));

        JsonObject response = handler.setPermissionDialogTimeoutAndCreateResponse("{}");

        assertEquals(300, settingsService.lastRequestedSeconds);
        assertEquals(300, response.get("permissionDialogTimeoutSeconds").getAsInt());
    }

    private HandlerContext contextWith(CodemossSettingsService settingsService) {
        return new HandlerContext(
                null,
                null,
                null,
                settingsService,
                new HandlerContext.JsCallback() {
                    @Override
                    public void callJavaScript(String functionName, String... args) {
                    }

                    @Override
                    public String escapeJs(String str) {
                        return str;
                    }
                }
        );
    }

    private static class FakeSettingsService extends CodemossSettingsService {
        private int effectiveSeconds = 300;
        private int lastRequestedSeconds = -1;

        @Override
        public void setPermissionDialogTimeoutSeconds(int seconds) throws IOException {
            lastRequestedSeconds = seconds;
            effectiveSeconds = CodemossSettingsService.clampPermissionDialogTimeoutSeconds(seconds);
        }

        @Override
        public int getPermissionDialogTimeoutSeconds() throws IOException {
            return effectiveSeconds;
        }
    }
}
