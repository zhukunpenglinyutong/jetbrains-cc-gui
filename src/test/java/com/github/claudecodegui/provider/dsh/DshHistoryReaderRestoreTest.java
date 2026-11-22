package com.github.claudecodegui.provider.dsh;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.concurrent.CancellationException;
import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class DshHistoryReaderRestoreTest {
    @Test
    public void missingOrMalformedResponsesCannotBecomeEmptySuccess() {
        for (JsonObject response : new JsonObject[]{null, new JsonObject()}) {
            assertThrows(IllegalStateException.class,
                    () -> fixture(response).getSessionMessages("session", "/fixture", () -> false));
        }
        JsonObject empty = new JsonObject();
        empty.addProperty("success", true);
        empty.add("messages", new JsonArray());
        assertTrue(fixture(empty).getSessionMessages("session", "/fixture", () -> false).isEmpty());
    }

    @Test
    public void providerTimeoutRemainsDistinctFromAnEmptyTranscript() {
        JsonObject timeout = new JsonObject();
        timeout.addProperty("success", false);
        timeout.addProperty("errorCode", "HISTORY_LOAD_PROVIDER_TIMEOUT");
        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> fixture(timeout).getSessionMessages("session", "/fixture", () -> false));
        assertTrue(error.getCause() instanceof TimeoutException);
    }

    @Test
    public void ordinaryCallsKeepTheirLegacyTimeoutAndInterruptContracts() {
        JsonObject timeout = new JsonObject();
        timeout.addProperty("success", false);
        timeout.addProperty("errorCode", "HISTORY_LOAD_PROVIDER_TIMEOUT");
        JsonObject listing = JsonParser.parseString(fixture(timeout).getSessionsForProjectAsJson("/fixture"))
                .getAsJsonObject();
        assertEquals("DSH bridge returned no session list", listing.get("error").getAsString());
        assertTrue(listing.getAsJsonArray("sessions").isEmpty());

        DshHistoryReader interrupted = new DshHistoryReader() {
            @Override
            JsonObject runDshCommand(String command, JsonObject payload, BooleanSupplier cancellation) {
                throw new CancellationException("History loading was interrupted");
            }
        };
        assertTrue(interrupted.getSessionMessages("session", "/fixture").isEmpty());
        assertFalse(interrupted.deleteSession("session", "/fixture"));
    }

    private DshHistoryReader fixture(JsonObject response) {
        return new DshHistoryReader() {
            @Override
            JsonObject runDshCommand(String command, JsonObject payload, BooleanSupplier cancellation) {
                return response;
            }
        };
    }
}
