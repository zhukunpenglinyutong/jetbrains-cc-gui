package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.Objects;

/** Versioned, bounded business envelope exchanged over authenticated local IPC. */
public record ClawBotIpcEnvelope(
        int protocolVersion,
        String type,
        String requestId,
        String instanceId,
        long connectionEpoch,
        JsonObject payload
) {

    static final int PROTOCOL_VERSION = 1;
    static final int MAX_IDENTIFIER_LENGTH = 256;
    static final int MAX_TYPE_LENGTH = 64;

    public ClawBotIpcEnvelope {
        if (protocolVersion != PROTOCOL_VERSION) {
            throw new IllegalArgumentException("CLAWBOT_IPC_PROTOCOL_UNSUPPORTED");
        }
        requireValue(type, "type", MAX_TYPE_LENGTH);
        requireValue(requestId, "requestId", MAX_IDENTIFIER_LENGTH);
        requireValue(instanceId, "instanceId", MAX_IDENTIFIER_LENGTH);
        if (connectionEpoch < 0) {
            throw new IllegalArgumentException("Invalid connectionEpoch");
        }
        payload = Objects.requireNonNull(payload, "payload").deepCopy();
    }

    JsonObject toJson() {
        JsonObject object = new JsonObject();
        object.addProperty("protocolVersion", protocolVersion);
        object.addProperty("type", type);
        object.addProperty("requestId", requestId);
        object.addProperty("instanceId", instanceId);
        object.addProperty("connectionEpoch", connectionEpoch);
        object.add("payload", payload.deepCopy());
        return object;
    }

    static ClawBotIpcEnvelope fromJson(JsonObject object) {
        Objects.requireNonNull(object, "object");
        JsonElement payload = object.get("payload");
        if (payload == null || !payload.isJsonObject()) {
            throw new IllegalArgumentException("CLAWBOT_IPC_PAYLOAD_INVALID");
        }
        return new ClawBotIpcEnvelope(
                readInt(object, "protocolVersion"),
                readString(object, "type"),
                readString(object, "requestId"),
                readString(object, "instanceId"),
                readLong(object, "connectionEpoch"),
                payload.getAsJsonObject());
    }

    private static String readString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        return value.getAsString();
    }

    private static int readInt(JsonObject object, String name) {
        try {
            return object.get(name).getAsInt();
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase(), error);
        }
    }

    private static long readLong(JsonObject object, String name) {
        try {
            return object.get(name).getAsLong();
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase(), error);
        }
    }

    private static void requireValue(String value, String name, int maxLength) {
        if (value == null || value.isBlank() || value.length() > maxLength
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid " + name);
        }
    }
}
