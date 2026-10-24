package com.github.claudecodegui.pet.office;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.identifier;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** Explicit navigation schema; no arbitrary IDE handler, answer or provider operation is accepted. */
final class PetOfficeRouteProtocol {
    private PetOfficeRouteProtocol() { }

    static JsonArray encode(List<PetOfficeRouteBroker.Command> commands) {
        JsonArray result = new JsonArray();
        for (var command : commands) {
            JsonObject value = new JsonObject();
            value.addProperty("page", command.page());
            value.addProperty("ticket", command.ticket());
            value.addProperty("navigationId", command.request().requestId());
            value.addProperty("sourceKey", command.request().sourceKey());
            value.addProperty("routeGeneration", command.request().routeGeneration());
            value.addProperty("interactionId", command.request().interactionId());
            value.addProperty("remainingMillis", command.remainingMillis());
            result.add(value);
        }
        return result;
    }

    static List<PetOfficeRouteBroker.Command> decode(JsonElement value, String instanceId) throws IOException {
        if (value == null || !value.isJsonArray() || value.getAsJsonArray().size() > 4) {
            throw new IOException("OFFICE_ROUTE_INVALID");
        }
        List<PetOfficeRouteBroker.Command> result = new ArrayList<>();
        for (JsonElement element : value.getAsJsonArray()) {
            if (!element.isJsonObject()) {
                throw new IOException("OFFICE_ROUTE_INVALID");
            }
            JsonObject item = element.getAsJsonObject();
            fields(item, "page", "ticket", "navigationId", "sourceKey", "routeGeneration", "interactionId", "remainingMillis");
            String source = string(item, "sourceKey", 388);
            try {
                if (!PetOfficeSessionRegistry.parseKey(source).instanceId().equals(instanceId)) {
                    throw new IOException("OFFICE_ROUTE_OWNER_INVALID");
                }
            } catch (IllegalArgumentException invalid) {
                throw new IOException("OFFICE_ROUTE_INVALID");
            }
            long remaining = integer(item, "remainingMillis", PetOfficeRouteBroker.DEADLINE_MILLIS);
            if (remaining == 0) {
                throw new IOException("OFFICE_ROUTE_EXPIRED");
            }
            result.add(new PetOfficeRouteBroker.Command(identifier(item, "page", false), identifier(item, "ticket", false),
                    new PetOfficeTabNavigator.Request(identifier(item, "navigationId", false), source,
                            identifier(item, "routeGeneration", false), identifier(item, "interactionId", true)), remaining));
        }
        return List.copyOf(result);
    }

    static PetOfficeRouteBroker.Reply decodeReply(JsonObject value) throws IOException {
        try {
            return new PetOfficeRouteBroker.Reply(identifier(value, "navigationId", false), identifier(value, "ticket", false),
                    PetOfficeTabNavigator.Result.valueOf(string(value, "navigationResult", 32)));
        } catch (IllegalArgumentException invalid) {
            throw new IOException("OFFICE_ROUTE_INVALID");
        }
    }
}
