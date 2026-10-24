package com.github.claudecodegui.handler;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

/** Tests Hooks bridge response correlation fields. */
public class HookHandlerTest {

    @Test
    public void attachesRequestedLocationToFailureResponse() {
        JsonObject request = new JsonObject();
        request.addProperty("location", "C:/project/.claude/settings.json");
        request.addProperty("sourceId", "hook-1");
        request.addProperty("requestId", "request-1");
        JsonObject response = new JsonObject();
        response.addProperty("success", false);
        response.addProperty("errorCode", "READ_FAILED");

        HookHandler.attachRequestedLocation(response, request);

        assertEquals(request.get("location").getAsString(), response.get("location").getAsString());
        assertEquals("hook-1", response.get("sourceId").getAsString());
        assertEquals("request-1", response.get("requestId").getAsString());
    }

    @Test
    public void preservesNormalizedLocationFromServiceResponse() {
        JsonObject request = new JsonObject();
        request.addProperty("location", "C:/project/.claude/../.claude/settings.json");
        JsonObject response = new JsonObject();
        response.addProperty("success", true);
        response.addProperty("location", "C:/project/.claude/settings.json");

        HookHandler.attachRequestedLocation(response, request);

        assertEquals("C:/project/.claude/settings.json", response.get("location").getAsString());
    }
}
