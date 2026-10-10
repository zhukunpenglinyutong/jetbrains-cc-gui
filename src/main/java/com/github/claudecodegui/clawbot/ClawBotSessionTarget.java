package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;

public record ClawBotSessionTarget(String handle, String instanceId, long connectionEpoch, String provider, String generation) {

    public ClawBotSessionTarget {
        for (String value : java.util.List.of(handle, instanceId, provider, generation)) {
            if (value.isBlank() || value.length() > 256 || value.chars().anyMatch(Character::isISOControl)) {
                throw new IllegalArgumentException("Invalid session target");
            }
        }
        if (connectionEpoch < 0) {
            throw new IllegalArgumentException("Invalid connection epoch");
        }
    }

    static ClawBotSessionTarget of(ClawBotSessionSnapshot session) {
        return new ClawBotSessionTarget(session.sessionHandleId(), session.instanceId(),
                session.connectionEpoch(), session.provider(), session.generation());
    }

    boolean matches(ClawBotSessionSnapshot session) {
        return session != null && equals(of(session));
    }

    JsonObject toJson() {
        JsonObject result = new JsonObject();
        result.addProperty("handle", handle);
        result.addProperty("instanceId", instanceId);
        result.addProperty("connectionEpoch", connectionEpoch);
        result.addProperty("provider", provider);
        result.addProperty("generation", generation);
        return result;
    }

    static ClawBotSessionTarget fromJson(JsonObject value) {
        return new ClawBotSessionTarget(readValue(value, "handle"), readValue(value, "instanceId"),
                readEpoch(value), readValue(value, "provider"), readValue(value, "generation"));
    }

    private static String readValue(JsonObject value, String name) {
        if (value == null || !value.has(name) || !value.get(name).isJsonPrimitive()
                || !value.get(name).getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("Invalid session target");
        }
        return value.get(name).getAsString();
    }

    private static long readEpoch(JsonObject value) {
        try {
            long epoch = value.get("connectionEpoch").getAsLong();
            if (epoch < 0) {
                throw new IllegalArgumentException("Invalid session target");
            }
            return epoch;
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("Invalid session target", error);
        }
    }
}
