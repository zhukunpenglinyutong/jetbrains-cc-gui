package com.github.claudecodegui.clawbot;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Converts sanitized session metadata to the versioned local IPC payload shape. */
final class ClawBotSessionWireCodec {

    private static final int MAX_SESSIONS = 256;

    private ClawBotSessionWireCodec() {
    }

    static JsonObject registrationToJson(ClawBotSessionRegistration registration) {
        JsonObject object = new JsonObject();
        object.addProperty("sessionHandleId", registration.sessionHandleId());
        object.addProperty("instanceId", registration.instanceId());
        object.addProperty("projectId", registration.projectId());
        object.addProperty("projectDisplayName", registration.projectDisplayName());
        object.addProperty("provider", registration.provider());
        object.addProperty("tabDisplayName", registration.tabDisplayName());
        object.addProperty("generation", registration.generation());
        object.add("capabilities", capabilitiesToJson(registration.capabilities()));
        object.addProperty("status", registration.status().name());
        object.addProperty("connectionEpoch", registration.connectionEpoch());
        return object;
    }

    static ClawBotSessionRegistration registrationFromJson(JsonObject object) throws IOException {
        return new ClawBotSessionRegistration(
                readString(object, "sessionHandleId"),
                readString(object, "instanceId"),
                readString(object, "projectId"),
                readString(object, "projectDisplayName"),
                readString(object, "provider"),
                readCapabilities(object.get("capabilities")),
                readStatus(object),
                readLong(object, "connectionEpoch"),
                readOptionalString(object, "tabDisplayName", "Chat"),
                readOptionalString(object, "generation", "legacy"));
    }

    static JsonArray registrationsToJson(List<ClawBotSessionRegistration> registrations) {
        JsonArray array = new JsonArray();
        registrations.stream()
                .sorted(Comparator.comparing(ClawBotSessionRegistration::sessionHandleId))
                .map(ClawBotSessionWireCodec::registrationToJson)
                .forEach(array::add);
        return array;
    }

    static List<ClawBotSessionRegistration> registrationsFromJson(JsonElement element) throws IOException {
        if (element == null || !element.isJsonArray() || element.getAsJsonArray().size() > MAX_SESSIONS) {
            throw new IOException("CLAWBOT_IPC_SESSIONS_INVALID");
        }
        List<ClawBotSessionRegistration> registrations = new ArrayList<>();
        for (JsonElement value : element.getAsJsonArray()) {
            if (!value.isJsonObject()) {
                throw new IOException("CLAWBOT_IPC_SESSION_INVALID");
            }
            try {
                registrations.add(registrationFromJson(value.getAsJsonObject()));
            } catch (IllegalArgumentException error) {
                throw new IOException("CLAWBOT_IPC_SESSION_INVALID", error);
            }
        }
        return List.copyOf(registrations);
    }

    static JsonArray snapshotsToJson(List<ClawBotSessionSnapshot> snapshots) {
        JsonArray array = new JsonArray();
        snapshots.stream()
                .sorted(Comparator.comparing(ClawBotSessionSnapshot::sessionHandleId))
                .map(ClawBotSessionWireCodec::snapshotToJson)
                .forEach(array::add);
        return array;
    }

    static List<ClawBotSessionSnapshot> snapshotsFromJson(JsonElement element) throws IOException {
        if (element == null || !element.isJsonArray() || element.getAsJsonArray().size() > MAX_SESSIONS) {
            throw new IOException("CLAWBOT_IPC_SESSIONS_INVALID");
        }
        List<ClawBotSessionSnapshot> snapshots = new ArrayList<>();
        for (JsonElement value : element.getAsJsonArray()) {
            if (!value.isJsonObject()) {
                throw new IOException("CLAWBOT_IPC_SESSION_INVALID");
            }
            snapshots.add(snapshotFromJson(value.getAsJsonObject()));
        }
        return List.copyOf(snapshots);
    }

    private static JsonObject snapshotToJson(ClawBotSessionSnapshot snapshot) {
        JsonObject object = new JsonObject();
        object.addProperty("sessionHandleId", snapshot.sessionHandleId());
        object.addProperty("instanceId", snapshot.instanceId());
        object.addProperty("projectId", snapshot.projectId());
        object.addProperty("projectDisplayName", snapshot.projectDisplayName());
        object.addProperty("provider", snapshot.provider());
        object.addProperty("tabDisplayName", snapshot.tabDisplayName());
        object.addProperty("generation", snapshot.generation());
        object.addProperty("idleMillis", snapshot.idleMillis());
        object.add("capabilities", capabilitiesToJson(snapshot.capabilities()));
        object.addProperty("status", snapshot.status().name());
        object.addProperty("connectionEpoch", snapshot.connectionEpoch());
        object.addProperty("registeredAtMillis", snapshot.registeredAtMillis());
        object.addProperty("lastHeartbeatAtMillis", snapshot.lastHeartbeatAtMillis());
        return object;
    }

    private static ClawBotSessionSnapshot snapshotFromJson(JsonObject object) throws IOException {
        try {
            return new ClawBotSessionSnapshot(
                    readString(object, "sessionHandleId"),
                    readString(object, "instanceId"),
                    readString(object, "projectId"),
                    readString(object, "projectDisplayName"),
                    readString(object, "provider"),
                    readCapabilities(object.get("capabilities")),
                    readStatus(object),
                    readLong(object, "connectionEpoch"),
                    readLong(object, "registeredAtMillis"),
                    readLong(object, "lastHeartbeatAtMillis"),
                    readOptionalString(object, "tabDisplayName", "Chat"),
                    readOptionalString(object, "generation", "legacy"),
                    object.has("idleMillis") ? readLong(object, "idleMillis") : 0);
        } catch (IllegalArgumentException error) {
            throw new IOException("CLAWBOT_IPC_SESSION_INVALID", error);
        }
    }

    private static JsonArray capabilitiesToJson(Set<String> capabilities) {
        JsonArray array = new JsonArray();
        capabilities.stream().sorted().forEach(array::add);
        return array;
    }

    private static Set<String> readCapabilities(JsonElement element) throws IOException {
        if (element == null || !element.isJsonArray() || element.getAsJsonArray().size() > 64) {
            throw new IOException("CLAWBOT_IPC_CAPABILITIES_INVALID");
        }
        Set<String> capabilities = new HashSet<>();
        for (JsonElement value : element.getAsJsonArray()) {
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
                throw new IOException("CLAWBOT_IPC_CAPABILITIES_INVALID");
            }
            capabilities.add(value.getAsString());
        }
        return Set.copyOf(capabilities);
    }

    private static ClawBotSessionStatus readStatus(JsonObject object) throws IOException {
        try {
            return ClawBotSessionStatus.valueOf(readString(object, "status"));
        } catch (IllegalArgumentException error) {
            throw new IOException("CLAWBOT_IPC_STATUS_INVALID", error);
        }
    }

    private static String readString(JsonObject object, String name) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        String result = value.getAsString();
        if (result.isBlank() || result.length() > 256 || result.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        return result;
    }

    private static String readOptionalString(JsonObject object, String name, String fallback) throws IOException {
        if (!object.has(name) || object.get(name).isJsonNull()) {
            return fallback;
        }
        return readString(object, name);
    }

    private static long readLong(JsonObject object, String name) throws IOException {
        try {
            long result = object.get(name).getAsLong();
            if (result < 0) {
                throw new NumberFormatException("negative");
            }
            return result;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase(), error);
        }
    }
}
