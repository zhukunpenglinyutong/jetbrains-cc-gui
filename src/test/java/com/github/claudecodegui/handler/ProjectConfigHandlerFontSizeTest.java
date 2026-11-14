package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.fail;

/** Verifies scale persistence and acknowledgement identity without starting JCEF. */
public class ProjectConfigHandlerFontSizeTest {

    /** Echoes the save identity so equal levels from different selections remain distinguishable. */
    @Test
    public void shouldAcknowledgeTheExactFontSizeSelection() throws Exception {
        RecordingSettings settings = new RecordingSettings();
        ProjectConfigHandler handler = new ProjectConfigHandler(new HandlerContext(null, null, null, settings, null));

        JsonObject response = handler.setFontSizeLevelAndCreateResponse(
                "{\"fontSizeLevel\":6,\"fontSizeRequestId\":\"page-selection-3\"}");
        assertEquals(6, settings.level);
        assertEquals(6, response.get("fontSizeLevel").getAsInt());
        assertEquals("page-selection-3", response.get("fontSizeRequestId").getAsString());

        JsonObject legacyResponse = handler.setFontSizeLevelAndCreateResponse("{\"fontSizeLevel\":2}");
        assertEquals(2, settings.level);
        assertFalse(legacyResponse.has("fontSizeRequestId"));
    }

    /** Rejects malformed values before they can replace the last valid scale. */
    @Test
    public void shouldRejectInvalidSelectionsBeforeSaving() throws Exception {
        RecordingSettings settings = new RecordingSettings();
        ProjectConfigHandler handler = new ProjectConfigHandler(new HandlerContext(null, null, null, settings, null));
        for (String content : new String[]{
                "null", "{}", "{\"fontSizeLevel\":null}", "{\"fontSizeLevel\":\"6\"}",
                "{\"fontSizeLevel\":2.5}", "{\"fontSizeLevel\":6.000000000000000001}",
                "{\"fontSizeLevel\":1e999}", "{\"fontSizeLevel\":0}", "{\"fontSizeLevel\":7}",
                "{\"fontSizeLevel\":6,\"fontSizeRequestId\":{}}"
        }) {
            try {
                handler.setFontSizeLevelAndCreateResponse(content);
                fail("Invalid selection must not be saved: " + content);
            } catch (IllegalArgumentException | ArithmeticException | JsonParseException expected) {
                assertEquals(3, settings.level);
            }
        }
    }

    private static class RecordingSettings extends CodemossSettingsService {
        private int level = 3;

        /** Records only valid writes so tests can detect persistence before validation. */
        @Override
        public void setFontSizeLevel(int level) {
            this.level = level;
        }

        /** Supplies the saved level without accessing user configuration. */
        @Override
        public Integer getFontSizeLevel() {
            return this.level;
        }

        /** Supplies font defaults without accessing user configuration. */
        @Override
        public JsonObject getUiFontConfig() {
            return new JsonObject();
        }
    }
}
