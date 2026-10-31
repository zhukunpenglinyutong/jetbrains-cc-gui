package com.github.claudecodegui.provider.dsh;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

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

    private DshHistoryReader fixture(JsonObject response) {
        return new DshHistoryReader() {
            @Override
            JsonObject runDshCommand(String command, JsonObject payload, BooleanSupplier cancellation) {
                return response;
            }
        };
    }
}
