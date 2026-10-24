package com.github.claudecodegui.pet.office;

import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;

import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/** Bounded, flat prototype protocol; no paths, provider IDs or executable actions. */
record PetOfficePrototypeMessage(String pageGeneration, String command, Metrics metrics,
                                Map<String, String> fields, long sequence, long protocolVersion, boolean topmost) {
    private static final long MAX_DECODED_CACHE_BYTES = 256L * 1024 * 1024;
    private static final Set<String> COMMANDS = Set.of("ready", "hide", "exit", "metrics", "sceneAck", "resync", "navigate", "asset", "setTopmost", "storage");
    private static final Set<String> STRING_FIELDS = Set.of("requestId", "sourceKey", "routeGeneration", "interactionId",
            "appearanceRevision", "assetDigest", "transferId", "operation", "payload");

    String field(String name) {
        return fields.getOrDefault(name, "");
    }

    static PetOfficePrototypeMessage parse(String message) throws IOException {
        if (message == null || message.length() > 65536 || message.getBytes(StandardCharsets.UTF_8).length > 65536) {
            throw new IOException("OFFICE_REQUEST_INVALID");
        }
        try (JsonReader reader = new JsonReader(new StringReader(message))) {
            reader.setLenient(false);
            String page = null;
            String command = null;
            Metrics metrics = null;
            Map<String, String> fields = new HashMap<>();
            long sequence = 0;
            long protocol = 0;
            boolean topmost = false;
            Set<String> seen = new HashSet<>();
            reader.beginObject();
            while (reader.hasNext()) {
                String name = reader.nextName();
                if (!seen.add(name)) {
                    throw new IOException("OFFICE_REQUEST_INVALID");
                }
                switch (name) {
                    case "pageGeneration":
                        page = readString(reader);
                        break;
                    case "command":
                        command = readString(reader);
                        break;
                    case "metrics":
                        metrics = readMetrics(reader);
                        break;
                    case "sequence":
                        sequence = readInteger(reader);
                        break;
                    case "protocolVersion":
                        protocol = readInteger(reader);
                        break;
                    case "topmost":
                        if (reader.peek() != JsonToken.BOOLEAN) {
                            throw new IOException("OFFICE_REQUEST_INVALID");
                        }
                        topmost = reader.nextBoolean();
                        break;
                    default:
                        if (!STRING_FIELDS.contains(name)) {
                            throw new IOException("OFFICE_REQUEST_INVALID");
                        }
                        String value = readString(reader);
                        if (value.length() > (name.equals("payload") ? 44000 : 512)) {
                            throw new IOException("OFFICE_REQUEST_INVALID");
                        }
                        fields.put(name, value);
                        break;
                }
            }
            reader.endObject();
            if (reader.peek() != JsonToken.END_DOCUMENT || page == null || page.length() > 64 || command == null) {
                throw new IOException("OFFICE_REQUEST_INVALID");
            }
            if (!COMMANDS.contains(command)) {
                throw new IOException("OFFICE_REQUEST_UNSUPPORTED");
            }
            if (!command.equals("storage") && message.getBytes(StandardCharsets.UTF_8).length > 8192) {
                throw new IOException("OFFICE_REQUEST_INVALID");
            }
            Set<String> expected = new HashSet<>(Set.of("pageGeneration", "command"));
            switch (command) {
                case "storage":
                    expected.addAll(Set.of("requestId", "operation", "payload"));
                    canonicalUuid(fields.get("requestId"));
                    if (!Set.of("petChoices", "preferences", "backgroundRead", "backgroundBegin", "backgroundChunk", "backgroundCommit", "backgroundRemove").contains(fields.get("operation"))) {
                        throw new IOException("OFFICE_REQUEST_INVALID");
                    }
                    break;
                case "ready":
                    if (seen.contains("protocolVersion")) {
                        expected.add("protocolVersion");
                    }
                    break;
                case "metrics":
                    expected.add("metrics");
                    break;
                case "setTopmost":
                    expected.add("topmost");
                    break;
                case "sceneAck":
                    expected.addAll(Set.of("transferId", "sequence"));
                    canonicalUuid(fields.get("transferId"));
                    break;
                case "navigate":
                    expected.addAll(Set.of("requestId", "sourceKey", "routeGeneration", "interactionId"));
                    canonicalUuid(fields.get("requestId"));
                    canonicalUuid(fields.get("routeGeneration"));
                    PetOfficeSessionRegistry.parseKey(fields.get("sourceKey"));
                    String interaction = fields.get("interactionId");
                    if (interaction == null || (!interaction.isEmpty() && !interaction.matches("[A-Za-z0-9._-]{1,128}"))) {
                        throw new IOException("OFFICE_REQUEST_INVALID");
                    }
                    break;
                case "asset":
                    expected.addAll(Set.of("requestId", "sourceKey", "appearanceRevision", "assetDigest"));
                    canonicalUuid(fields.get("requestId"));
                    PetOfficeSessionRegistry.parseKey(fields.get("sourceKey"));
                    if (!fields.getOrDefault("appearanceRevision", "").matches("[a-f0-9]{64}")
                            || !fields.getOrDefault("assetDigest", "").matches("[a-f0-9]{64}")) {
                        throw new IOException("OFFICE_REQUEST_INVALID");
                    }
                    break;
                default:
                    break;
            }
            if (!expected.equals(seen) || "metrics".equals(command) != (metrics != null)) {
                throw new IOException("OFFICE_REQUEST_INVALID");
            }
            return new PetOfficePrototypeMessage(page, command, metrics, Map.copyOf(fields), sequence, protocol, topmost);
        } catch (IllegalStateException | IllegalArgumentException malformed) {
            throw new IOException("OFFICE_REQUEST_INVALID");
        }
    }

    private static void canonicalUuid(String value) throws IOException {
        if (value == null || !java.util.UUID.fromString(value).toString().equals(value)) {
            throw new IOException("OFFICE_REQUEST_INVALID");
        }
    }

    private static long readInteger(JsonReader reader) throws IOException {
        if (reader.peek() != JsonToken.NUMBER) {
            throw new IOException("OFFICE_REQUEST_INVALID");
        }
        long value = Long.parseLong(reader.nextString());
        if (value < 0 || value > 9_007_199_254_740_991L) {
            throw new IOException("OFFICE_REQUEST_INVALID");
        }
        return value;
    }

    private static String readString(JsonReader reader) throws IOException {
        if (reader.peek() != JsonToken.STRING) {
            throw new IOException("OFFICE_REQUEST_INVALID");
        }
        return reader.nextString();
    }

    private static Metrics readMetrics(JsonReader reader) throws IOException {
        long frames = 0;
        double fps = 0;
        double draw = 0;
        boolean running = false;
        int visible = 0;
        long decoded = 0;
        Set<String> seen = new HashSet<>();
        reader.beginObject();
        while (reader.hasNext()) {
            String name = reader.nextName();
            if (!seen.add(name)) {
                throw new IOException("OFFICE_REQUEST_INVALID");
            }
            if ("running".equals(name)) {
                if (reader.peek() != JsonToken.BOOLEAN) {
                    throw new IOException("OFFICE_REQUEST_INVALID");
                }
                running = reader.nextBoolean();
                continue;
            }
            if (reader.peek() != JsonToken.NUMBER) {
                throw new IOException("OFFICE_REQUEST_INVALID");
            }
            switch (name) {
                case "frames":
                    frames = reader.nextLong();
                    break;
                case "fps":
                    fps = reader.nextDouble();
                    break;
                case "drawMs":
                    draw = reader.nextDouble();
                    break;
                case "visibleSources":
                    visible = reader.nextInt();
                    break;
                case "decodedBytes":
                    decoded = reader.nextLong();
                    break;
                default:
                    throw new IOException("OFFICE_REQUEST_INVALID");
            }
        }
        reader.endObject();
        if (seen.size() != 6 || frames < 0 || frames > 9_007_199_254_740_991L || !Double.isFinite(fps) || !Double.isFinite(draw)
                || fps < 0 || fps > 200 || draw < 0 || draw > 10000 || visible < 0 || visible > 25 || decoded < 0 || decoded > MAX_DECODED_CACHE_BYTES) {
            throw new IOException("OFFICE_REQUEST_INVALID");
        }
        return new Metrics(frames, fps, draw, running, visible, decoded);
    }

    record Metrics(long frames, double fps, double drawMs, boolean running, int visibleSources, long decodedBytes) {
    }
}
