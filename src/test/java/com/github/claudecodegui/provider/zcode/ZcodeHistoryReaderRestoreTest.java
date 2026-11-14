package com.github.claudecodegui.provider.zcode;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class ZcodeHistoryReaderRestoreTest {
    @Test
    public void missingOrMalformedResponsesAreFailuresAndExplicitEmptyMessagesAreValid() {
        for (JsonObject payload : new JsonObject[]{null, new JsonObject()}) {
            ZcodeHistoryReader reader = fixture(payload, false);
            assertThrows(IllegalStateException.class, () -> reader.getSessionMessages("session", "/fixture", () -> false));
        }
        JsonObject empty = new JsonObject();
        empty.addProperty("success", true);
        empty.add("messages", new JsonArray());
        assertTrue(fixture(empty, false).getSessionMessages("session", "/fixture", () -> false).isEmpty());
    }

    @Test
    public void providerTimeoutSurvivesTheStrictHistoryBoundary() {
        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> fixture(null, true).getSessionMessages("session", "/fixture", () -> false));
        assertTrue(error.getCause() instanceof TimeoutException);
    }

    @Test
    public void ordinaryListingKeepsItsWarningOnlyTimeoutContract() {
        JsonObject listing = JsonParser.parseString(fixture(null, true).getSessionsForProjectAsJson("/fixture"))
                .getAsJsonObject();

        assertFalse(listing.get("success").getAsBoolean());
        assertEquals("No listSessions result from ZCode channel-manager", listing.get("error").getAsString());
        assertFalse(fixture(null, true).deleteSession("session", "/fixture"));
    }

    private ZcodeHistoryReader fixture(JsonObject response, boolean timeout) {
        return new ZcodeHistoryReader() {
            @Override
            JsonObject runCommand(String command, JsonObject payload, BooleanSupplier cancellation) throws Exception {
                if (timeout) {
                    throw new TimeoutException("Fixture timeout");
                }
                return response;
            }
        };
    }
}
