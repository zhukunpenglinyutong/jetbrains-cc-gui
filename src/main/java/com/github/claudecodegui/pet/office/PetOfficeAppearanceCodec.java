package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.fields;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.integer;
import static com.github.claudecodegui.pet.office.PetOfficeIpcFrameCodec.string;

/** Strict appearance metadata admission, independent of source snapshot/heartbeat authority. */
final class PetOfficeAppearanceCodec {
    static final int MAX_CATALOG_BYTES = 2 * 1024 * 1024;
    private static final Gson JSON = new Gson();
    private static final Set<String> ACTIONS = Set.of("idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review");
    private static final Set<String> STATES = Set.of("idle", "running", "thinking", "success", "error");
    private static final Set<String> STATUS = Set.of("READY", "BUILTIN", "ASSET_UNAVAILABLE", "ASSET_CAPACITY", "ASSET_BUSY");

    private PetOfficeAppearanceCodec() { }

    static byte[] encode(Map<String, PetOfficeAppearanceService.Appearance> catalog, String owner) throws IOException {
        JsonArray sources = new JsonArray();
        catalog.forEach((key, appearance) -> {
            JsonObject entry = new JsonObject();
            entry.addProperty("sourceKey", key);
            entry.add("appearance", JSON.toJsonTree(appearance));
            sources.add(entry);
        });
        JsonObject value = new JsonObject();
        value.add("sources", sources);
        byte[] bytes = value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        decode(bytes, owner);
        return bytes;
    }

    static Map<String, PetOfficeAppearanceService.Appearance> decode(byte[] bytes, String owner) throws IOException {
        if (bytes.length == 0 || bytes.length > MAX_CATALOG_BYTES) {
            throw new IOException("OFFICE_ASSET_CAPACITY");
        }
        try {
            JsonObject value = PetOfficeIpcFrameCodec.parse(bytes);
            fields(value, "sources");
            if (!value.get("sources").isJsonArray() || value.getAsJsonArray("sources").size() > PetOfficeSessionRegistry.MAX_SOURCES) {
                throw new IOException("OFFICE_ASSET_INVALID");
            }
            Map<String, PetOfficeAppearanceService.Appearance> result = new LinkedHashMap<>();
            for (JsonElement raw : value.getAsJsonArray("sources")) {
                JsonObject entry = raw.getAsJsonObject();
                fields(entry, "sourceKey", "appearance");
                String key = string(entry, "sourceKey", 512);
                if (!PetOfficeSessionRegistry.parseKey(key).instanceId().equals(owner) || result.containsKey(key)) {
                    throw new IOException("OFFICE_ASSET_STALE");
                }
                JsonObject appearance = entry.getAsJsonObject("appearance");
                fields(appearance, "revision", "scope", "opacity", "actionMappings", "status", "manifest");
                if (!string(appearance, "revision", 64).matches("[a-f0-9]{64}")
                        || !Set.of("project", "global").contains(string(appearance, "scope", 16))
                        || !STATUS.contains(string(appearance, "status", 32))) {
                    throw new IOException("OFFICE_ASSET_INVALID");
                }
                JsonElement opacity = appearance.get("opacity");
                if (!opacity.isJsonPrimitive() || !opacity.getAsJsonPrimitive().isNumber()
                        || !Double.isFinite(opacity.getAsDouble()) || opacity.getAsDouble() < 0.3 || opacity.getAsDouble() > 1) {
                    throw new IOException("OFFICE_ASSET_INVALID");
                }
                JsonObject mappings = appearance.getAsJsonObject("actionMappings");
                if (!mappings.keySet().equals(STATES)) {
                    throw new IOException("OFFICE_ASSET_INVALID");
                }
                for (var actions : mappings.entrySet()) {
                    JsonArray list = actions.getValue().getAsJsonArray();
                    if (list.isEmpty() || list.size() > ACTIONS.size()) {
                        throw new IOException("OFFICE_ASSET_INVALID");
                    }
                    for (JsonElement action : list) {
                        if (!action.isJsonPrimitive() || !action.getAsJsonPrimitive().isString() || !ACTIONS.contains(action.getAsString())) {
                            throw new IOException("OFFICE_ASSET_INVALID");
                        }
                    }
                }
                manifest(appearance.getAsJsonObject("manifest"));
                result.put(key, JSON.fromJson(appearance, PetOfficeAppearanceService.Appearance.class));
            }
            return Map.copyOf(result);
        } catch (RuntimeException invalid) {
            throw new IOException("OFFICE_ASSET_INVALID");
        }
    }

    static PetOfficeAppearanceService.Manifest manifest(JsonObject value) throws IOException {
        fields(value, "digest", "kind", "mime", "width", "height", "byteLength");
        String digest = string(value, "digest", 64);
        String kind = string(value, "kind", 16);
        String mime = string(value, "mime", 32);
        long width = integer(value, "width", 4096);
        long height = integer(value, "height", 4096);
        long length = integer(value, "byteLength", PetOfficeAppearanceService.MAX_IMAGE_BYTES);
        if (width == 0 || height == 0 || width * height > 6_500_000) {
            throw new IOException("OFFICE_ASSET_INVALID");
        }
        if (kind.equals("builtin")) {
            if (!digest.isEmpty() || !mime.isEmpty() || length != 0 || width != 192 || height != 208) {
                throw new IOException("OFFICE_ASSET_INVALID");
            }
        } else if (!Set.of("sheet", "image").contains(kind) || !digest.matches("[a-f0-9]{64}") || length == 0
                || !Set.of("image/png", "image/jpeg", "image/gif", "image/webp").contains(mime)
                || kind.equals("sheet") && (width != 1536 || height < 1872 || height % 208 != 0)) {
            throw new IOException("OFFICE_ASSET_INVALID");
        }
        return JSON.fromJson(value, PetOfficeAppearanceService.Manifest.class);
    }

    static JsonObject endpoint(PetOfficeEndpointStore.Endpoint endpoint) {
        JsonObject value = new JsonObject();
        value.addProperty("port", endpoint.port());
        value.addProperty("leaderEpoch", endpoint.leaderEpoch());
        value.addProperty("token", endpoint.token());
        value.addProperty("ownerInstanceId", endpoint.ownerInstanceId());
        return value;
    }

    static PetOfficeEndpointStore.Endpoint endpoint(JsonObject value, String owner) throws IOException {
        fields(value, "port", "leaderEpoch", "token", "ownerInstanceId");
        int port = (int) integer(value, "port", 65535);
        String epoch = PetOfficeIpcFrameCodec.identifier(value, "leaderEpoch", false);
        String token = string(value, "token", 64);
        if (port == 0 || !string(value, "ownerInstanceId", 128).equals(owner) || !token.matches("[a-f0-9]{64}")) {
            throw new IOException("OFFICE_ASSET_INVALID");
        }
        return new PetOfficeEndpointStore.Endpoint(port, epoch, token, owner);
    }
}
