package com.github.claudecodegui.provider.zcode;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.concurrent.TimeoutException;
import java.util.function.BooleanSupplier;

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
