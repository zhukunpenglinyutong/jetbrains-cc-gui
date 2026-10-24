package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.identifier;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** Typed, metadata-only participant snapshots. Reflection follows complete bounded schema validation. */
final class PetOfficeParticipantSnapshotCodec {
    static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final long MAX_INTEGER = 9_007_199_254_740_991L;
    private static final Gson JSON = new Gson();

    private PetOfficeParticipantSnapshotCodec() { }

    static byte[] encode(PetOfficeSessionRegistry.CompleteSnapshot snapshot, String connectionEpoch) throws IOException {
        var copy = new PetOfficeSessionRegistry.CompleteSnapshot(snapshot.schemaVersion(), snapshot.instanceId(), connectionEpoch,
                snapshot.watermark(), snapshot.sampledAt(), snapshot.sources(), snapshot.recentResults(), snapshot.capacityReached());
        byte[] bytes = JSON.toJson(copy).getBytes(StandardCharsets.UTF_8);
        decode(bytes, snapshot.instanceId(), connectionEpoch);
        return bytes;
    }

    static PetOfficeSessionRegistry.CompleteSnapshot decode(byte[] bytes, String instanceId, String connectionEpoch) throws IOException {
        if (bytes.length == 0 || bytes.length > MAX_BYTES) {
            throw new IOException("OFFICE_SNAPSHOT_CAPACITY");
        }
        try {
            JsonObject value = PetOfficeIpcFrameCodec.parse(bytes);
            fields(value, "schemaVersion", "instanceId", "connectionEpoch", "watermark", "sampledAt", "sources", "recentResults", "capacityReached");
            if (integer(value, "schemaVersion", 1) != 1 || !identifier(value, "instanceId", false).equals(instanceId)
                    || !identifier(value, "connectionEpoch", false).equals(connectionEpoch)) {
                throw new IOException("OFFICE_SNAPSHOT_OWNER_INVALID");
            }
            integer(value, "watermark", MAX_INTEGER);
            integer(value, "sampledAt", MAX_INTEGER);
            booleanField(value, "capacityReached");
            Set<String> seen = new HashSet<>();
            for (JsonElement raw : array(value, "sources", PetOfficeSessionRegistry.MAX_SOURCES)) {
                JsonObject source = object(raw);
                fields(source, "sourceKey", "sourceRevision", "metadata", "provider", "modelLabel", "execution", "routeStatus",
                        "routeGeneration", "observationRevision", "observationAgeMillis", "terminalGraceRemainingMillis");
                String key = key(source, instanceId);
                if (!seen.add(key)) {
                    throw new IOException("OFFICE_SNAPSHOT_DUPLICATE_SOURCE");
                }
                metadata(source, key);
                string(source, "provider", 160);
                string(source, "modelLabel", 160);
                enumeration(source, "routeStatus", PetOfficeSessionRegistry.RouteStatus.class);
                identifier(source, "routeGeneration", false);
                integer(source, "sourceRevision", MAX_INTEGER);
                integer(source, "observationRevision", MAX_INTEGER);
                integer(source, "observationAgeMillis", MAX_INTEGER);
                integer(source, "terminalGraceRemainingMillis", PetOfficeSessionRegistry.TERMINAL_GRACE_MILLIS);
                execution(source, key);
            }
            seen.clear();
            for (JsonElement raw : array(value, "recentResults", PetOfficeSessionRegistry.MAX_RECENT_RESULTS)) {
                JsonObject result = object(raw);
                fields(result, "sourceKey", "metadata", "provider", "modelLabel", "turnId", "outcome", "terminalEventId", "completedAt");
                metadata(result, key(result, instanceId));
                string(result, "provider", 160);
                string(result, "modelLabel", 160);
                identifier(result, "turnId", false);
                String event = identifier(result, "terminalEventId", false);
                if (!seen.add(event) || enumeration(result, "outcome", SessionExecutionState.Outcome.class) == SessionExecutionState.Outcome.NONE) {
                    throw new IOException("OFFICE_SNAPSHOT_OUTCOME_INVALID");
                }
                integer(result, "completedAt", MAX_INTEGER);
            }
            return JSON.fromJson(value, PetOfficeSessionRegistry.CompleteSnapshot.class);
        } catch (RuntimeException invalid) {
            throw new IOException("OFFICE_SNAPSHOT_INVALID");
        }
    }

    private static void execution(JsonObject source, String key) throws IOException {
        JsonObject execution = object(source.get("execution"));
        fields(execution, "bindingEpoch", "turnId", "phase", "waitReason", "pendingInteractionId", "pendingInteractionCount", "outcome",
                "terminalEventId", "startedAt", "completedAt", "revision");
        if (!identifier(execution, "bindingEpoch", false).equals(key.split("/")[2])) {
            throw new IOException("OFFICE_SNAPSHOT_BINDING_INVALID");
        }
        identifier(execution, "turnId", true);
        var phase = enumeration(execution, "phase", SessionExecutionState.Phase.class);
        var reason = enumeration(execution, "waitReason", SessionExecutionState.WaitReason.class);
        String interaction = identifier(execution, "pendingInteractionId", true);
        long count = integer(execution, "pendingInteractionCount", 16);
        boolean waiting = phase == SessionExecutionState.Phase.WAITING_USER;
        if (waiting ? reason == SessionExecutionState.WaitReason.NONE || interaction.isEmpty() || count == 0
                : reason != SessionExecutionState.WaitReason.NONE || !interaction.isEmpty() || count != 0) {
            throw new IOException("OFFICE_SNAPSHOT_WAIT_INVALID");
        }
        enumeration(execution, "outcome", SessionExecutionState.Outcome.class);
        identifier(execution, "terminalEventId", true);
        integer(execution, "startedAt", MAX_INTEGER);
        integer(execution, "completedAt", MAX_INTEGER);
        integer(execution, "revision", MAX_INTEGER);
    }

    private static String key(JsonObject source, String owner) throws IOException {
        JsonObject key = object(source.get("sourceKey"));
        fields(key, "instanceId", "contentHandleId", "bindingEpoch");
        if (!identifier(key, "instanceId", false).equals(owner)) {
            throw new IOException("OFFICE_SNAPSHOT_OWNER_INVALID");
        }
        return owner + "/" + identifier(key, "contentHandleId", false) + "/" + identifier(key, "bindingEpoch", false);
    }

    private static void metadata(JsonObject source, String key) throws IOException {
        JsonObject metadata = object(source.get("metadata"));
        fields(metadata, "contentHandleId", "productCode", "productName", "projectId", "projectLabel", "tabLabel");
        if (!identifier(metadata, "contentHandleId", false).equals(key.split("/")[1])) {
            throw new IOException("OFFICE_SNAPSHOT_BINDING_INVALID");
        }
        identifier(metadata, "projectId", false);
        for (String name : new String[]{"productCode", "productName", "projectLabel", "tabLabel"}) {
            string(metadata, name, 160);
        }
    }

    private static <T extends Enum<T>> T enumeration(JsonObject value, String name, Class<T> type) throws IOException {
        try {
            return Enum.valueOf(type, string(value, name, 32));
        } catch (IllegalArgumentException invalid) {
            throw new IOException("OFFICE_SNAPSHOT_ENUM_INVALID");
        }
    }

    private static void booleanField(JsonObject value, String name) throws IOException {
        JsonElement field = value.get(name);
        if (field == null || !field.isJsonPrimitive() || !field.getAsJsonPrimitive().isBoolean()) {
            throw new IOException("OFFICE_SNAPSHOT_INVALID");
        }
    }

    private static JsonObject object(JsonElement value) throws IOException {
        if (value == null || !value.isJsonObject()) {
            throw new IOException("OFFICE_SNAPSHOT_INVALID");
        }
        return value.getAsJsonObject();
    }

    private static JsonArray array(JsonObject value, String name, int max) throws IOException {
        JsonElement field = value.get(name);
        if (field == null || !field.isJsonArray() || field.getAsJsonArray().size() > max) {
            throw new IOException("OFFICE_SNAPSHOT_CAPACITY");
        }
        return field.getAsJsonArray();
    }
}
