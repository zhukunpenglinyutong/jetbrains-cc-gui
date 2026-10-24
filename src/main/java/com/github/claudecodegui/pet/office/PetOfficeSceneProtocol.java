package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Dedicated page protocol. Only complete, digested, bounded transfers may replace a scene or image. */
public final class PetOfficeSceneProtocol {
    public static final int VERSION = 1;
    public static final int CHUNK_BYTES = 32 * 1024;
    public static final int MAX_FRAME_BYTES = 64 * 1024;
    public static final int MAX_SCENE_BYTES = 2 * 1024 * 1024;
    private static final Gson JSON = new Gson();

    public record Scene(PetOfficeSessionRegistry.CompleteSnapshot snapshot,
                        Map<String, PetOfficeAppearanceService.Appearance> appearances, List<String> participants) {
        public Scene {
            appearances = Map.copyOf(appearances);
            participants = List.copyOf(participants);
            if (participants.isEmpty() || participants.size() > PetOfficeParticipantRegistry.MAX_PARTICIPANTS
                    || !participants.contains(snapshot.instanceId()) || new java.util.HashSet<>(participants).size() != participants.size()) {
                throw new IllegalArgumentException("OFFICE_SCENE_PARTICIPANTS_INVALID");
            }
            for (var source : snapshot.sources()) {
                if (!participants.contains(source.sourceKey().instanceId())) {
                    throw new IllegalArgumentException("OFFICE_SCENE_PARTICIPANTS_INVALID");
                }
            }
            for (var result : snapshot.recentResults()) {
                if (!participants.contains(result.sourceKey().instanceId())) {
                    throw new IllegalArgumentException("OFFICE_SCENE_PARTICIPANTS_INVALID");
                }
            }
        }

        public Scene(PetOfficeSessionRegistry.CompleteSnapshot snapshot, Map<String, PetOfficeAppearanceService.Appearance> appearances) {
            this(snapshot, appearances, List.of(snapshot.instanceId()));
        }
    }

    public record Transfer(String id, long sequence, List<String> frames) {
        public Transfer {
            frames = List.copyOf(frames);
        }
    }

    private PetOfficeSceneProtocol() { }

    public static Transfer scene(String page, long sequence, Scene scene) throws IOException {
        if (scene.snapshot().sources().size() > PetOfficeSessionRegistry.MAX_SOURCES
                || scene.snapshot().recentResults().size() > PetOfficeSessionRegistry.MAX_RECENT_RESULTS
                || scene.appearances().size() > PetOfficeSessionRegistry.MAX_SOURCES) {
            throw new IOException("OFFICE_SCENE_CAPACITY");
        }
        byte[] bytes = JSON.toJson(scene).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_SCENE_BYTES) {
            throw new IOException("OFFICE_SCENE_CAPACITY");
        }
        return transfer(page, sequence, "SCENE", bytes, Map.of());
    }

    public static Transfer asset(String page, String requestId, String sourceKey, String revision,
                                 PetOfficeAppearanceService.Manifest manifest, byte[] bytes) throws IOException {
        if (bytes.length == 0 || bytes.length > PetOfficeAppearanceService.MAX_IMAGE_BYTES
                || bytes.length != manifest.byteLength() || !manifest.digest().equals(PetOfficeAppearanceService.digest(bytes))) {
            throw new IOException("OFFICE_ASSET_INVALID");
        }
        return transfer(page, 0, "ASSET", bytes,
                Map.of("requestId", requestId, "sourceKey", sourceKey, "appearanceRevision", revision, "manifest", manifest));
    }

    private static Transfer transfer(String page, long sequence, String type, byte[] bytes, Map<String, Object> metadata) throws IOException {
        if (page == null || page.length() > 64 || sequence < 0 || sequence > 9_007_199_254_740_991L) {
            throw new IOException("OFFICE_TRANSFER_INVALID");
        }
        String id = UUID.randomUUID().toString();
        int count = (bytes.length + CHUNK_BYTES - 1) / CHUNK_BYTES;
        List<String> frames = new ArrayList<>(count + 2);
        Map<String, Object> begin = envelope(page, sequence, type + "_BEGIN", id);
        begin.put("byteLength", bytes.length);
        begin.put("chunkCount", count);
        begin.put("digest", PetOfficeAppearanceService.digest(bytes));
        begin.putAll(metadata);
        frames.add(frame(begin));
        for (int index = 0; index < count; index++) {
            Map<String, Object> chunk = envelope(page, sequence, type + "_CHUNK", id);
            chunk.put("index", index);
            chunk.put("data", Base64.getEncoder().encodeToString(Arrays.copyOfRange(bytes,
                    index * CHUNK_BYTES, Math.min(bytes.length, (index + 1) * CHUNK_BYTES))));
            frames.add(frame(chunk));
        }
        frames.add(frame(envelope(page, sequence, type + "_COMMIT", id)));
        return new Transfer(id, sequence, frames);
    }

    private static Map<String, Object> envelope(String page, long sequence, String type, String id) {
        Map<String, Object> packet = new LinkedHashMap<>();
        packet.put("schemaVersion", VERSION);
        packet.put("pageGeneration", page);
        packet.put("type", type);
        packet.put("transferId", id);
        packet.put("sequence", sequence);
        return packet;
    }

    private static String frame(Map<String, Object> value) throws IOException {
        String result = JSON.toJson(value);
        if (result.getBytes(StandardCharsets.UTF_8).length > MAX_FRAME_BYTES) {
            throw new IOException("OFFICE_FRAME_CAPACITY");
        }
        return result;
    }

    public static String result(String page, String requestId, String result) {
        return JSON.toJson(Map.of("schemaVersion", VERSION, "pageGeneration", page, "type", "REQUEST_RESULT",
                "requestId", requestId, "result", result));
    }
}
