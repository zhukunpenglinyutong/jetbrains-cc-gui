package com.github.claudecodegui.storage;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Metadata-only receipts. Mutations require the maintenance mutex and shared directory admission. */
public final class CodexMaintenanceJournal {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Set<String> TERMINAL = Set.of("COMPLETED", "COMPLETED_WITH_WARNINGS", "PARTIAL_COMPLETED", "FAILED_CLEAN", "CANCELLED_CLEAN");
    private final Path directory;

    public CodexMaintenanceJournal(Path coordinationDirectory) {
        this.directory = coordinationDirectory.resolve("codex-maintenance").toAbsolutePath().normalize();
    }

    public static boolean blocksAdmission(Path coordinationDirectory) throws IOException {
        return new CodexMaintenanceJournal(coordinationDirectory).hasPending();
    }

    public boolean hasPending() throws IOException {
        Path marker = directory.getParent().resolve("codex-maintenance-pending.json");
        if (Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
            try {
                if (Files.isSymbolicLink(marker) || Files.size(marker) > 4096) {
                    throw new IOException("MAINTENANCE_JOURNAL_INVALID");
                }
                String id = JsonParser.parseString(Files.readString(marker, StandardCharsets.UTF_8)).getAsJsonObject().get("operationId").getAsString();
                JsonObject record = get(id);
                if (record == null || !terminal(record)) {
                    return true;
                }
            } catch (RuntimeException error) {
                throw new IOException("MAINTENANCE_JOURNAL_INVALID", error);
            }
        }
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            return false;
        }
        checkDirectory();
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                if (!terminal(read(file))) {
                    return true;
                }
            }
        }
        return false;
    }

    public JsonObject claim(String operationId, String kind, CodexStoragePaths paths, List<String> targets, boolean legacy) throws IOException {
        validateId(operationId);
        Files.createDirectories(directory);
        checkDirectory();
        pruneTerminalDetails();
        JsonObject existing = get(operationId);
        String digest = binding(kind, paths.identity(), targets);
        if (existing != null) {
            if (!digest.equals(existing.get("binding").getAsString())) {
                throw new IOException("OPERATION_ID_CONFLICT");
            }
            return existing;
        }
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                JsonObject pending = read(file);
                if (!terminal(pending)) {
                    if (legacy && digest.equals(pending.get("binding").getAsString())) {
                        return pending;
                    }
                    throw new IOException("MAINTENANCE_RECONCILIATION_REQUIRED");
                }
            }
        }
        if (hasPending()) {
            throw new IOException("MAINTENANCE_RECONCILIATION_REQUIRED");
        }
        JsonObject record = new JsonObject();
        record.addProperty("version", 1);
        record.addProperty("operationId", operationId);
        record.addProperty("kind", kind);
        record.addProperty("origin", legacy ? "HISTORY" : "STORAGE");
        record.addProperty("binding", digest);
        record.addProperty("rootIdentity", paths.identity());
        record.addProperty("canonicalRoot", paths.canonical().toString());
        record.addProperty("physicalRoot", paths.root().toString());
        record.addProperty("createdAt", Instant.now().toString());
        record.add("targets", GSON.toJsonTree(targets));
        record.add("checkpoints", new JsonObject());
        state(record, "ACCEPTED");
        return record;
    }

    public JsonObject get(String operationId) throws IOException {
        validateId(operationId);
        Path file = directory.resolve(operationId + ".json");
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            return null;
        }
        checkDirectory();
        return read(file);
    }

    public JsonArray list(CodexStoragePaths paths) throws IOException {
        JsonArray result = new JsonArray();
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            return result;
        }
        checkDirectory();
        List<JsonObject> records = new java.util.ArrayList<>();
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                JsonObject record = read(file);
                JsonObject details = record.has("result") ? record.getAsJsonObject("result") : new JsonObject();
                boolean metadataUnfinished = details.has("metadataStatus") && !details.get("metadataStatus").getAsString().equals("COMPLETE");
                if (paths.identity().equals(record.get("rootIdentity").getAsString())
                        && !(terminal(record) && record.has("origin") && record.get("origin").getAsString().equals("HISTORY") && !metadataUnfinished)) {
                    records.add(publicStatus(record));
                }
            }
        }
        records.sort(Comparator.comparing((JsonObject record) -> terminal(record))
                .thenComparing(record -> record.get("createdAt").getAsString(), Comparator.reverseOrder()));
        records.stream().limit(50).forEach(result::add);
        return result;
    }

    /** Resolve a native client's home only when maintenance receipts actually exist. */
    public void requireSessionAvailable(Path codexHome, String sessionId) throws IOException {
        if (sessionId == null || sessionId.isBlank() || !Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        requireSessionAvailable(new CodexStoragePaths(codexHome), sessionId);
    }

    /** Called while holding process admission so a queued resume cannot resurrect deleted history. */
    public void requireSessionAvailable(CodexStoragePaths paths, String sessionId) throws IOException {
        if (sessionId == null || sessionId.isBlank() || !Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        checkDirectory();
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                JsonObject record = read(file);
                if (paths.identity().equals(record.get("rootIdentity").getAsString()) && record.has("family")
                        && record.has("mutationStarted")) {
                    for (var id : record.getAsJsonArray("family")) {
                        if (sessionId.equals(id.getAsString())) {
                            throw new IOException("SESSION_PERMANENTLY_DELETED");
                        }
                    }
                }
            }
        }
    }

    public void state(JsonObject record, String state) throws IOException {
        record.addProperty("state", state);
        record.addProperty("updatedAt", Instant.now().toString());
        save(record);
        Path marker = directory.getParent().resolve("codex-maintenance-pending.json");
        if (!terminal(record)) {
            JsonObject pending = new JsonObject();
            pending.add("operationId", record.get("operationId"));
            Path temporary = directory.resolve(".pending.tmp");
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer buffer = ByteBuffer.wrap(pending.toString().getBytes(StandardCharsets.UTF_8));
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, marker, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } else {
            if (Files.exists(marker, LinkOption.NOFOLLOW_LINKS)) {
                JsonObject pending = JsonParser.parseString(Files.readString(marker, StandardCharsets.UTF_8)).getAsJsonObject();
                if (record.get("operationId").equals(pending.get("operationId"))) {
                    Files.delete(marker);
                }
            }
        }
    }

    public void save(JsonObject record) throws IOException {
        String id = record.get("operationId").getAsString();
        validateId(id);
        checkDirectory();
        byte[] bytes = GSON.toJson(record).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 4 * 1024 * 1024) {
            throw new IOException("MAINTENANCE_RECORD_TOO_LARGE");
        }
        Path temporary = directory.resolve("." + id + ".tmp");
        if (Files.isSymbolicLink(temporary)) {
            throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
        }
        try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) {
                channel.write(buffer);
            }
            channel.force(true);
        }
        // An unsupported atomic move must fail before subsequent source mutation.
        Files.move(temporary, directory.resolve(id + ".json"), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    public static boolean terminal(JsonObject record) {
        return record.has("state") && TERMINAL.contains(record.get("state").getAsString());
    }

    public static JsonObject publicStatus(JsonObject record) {
        JsonObject status = new JsonObject();
        for (String field : List.of("operationId", "kind", "state", "createdAt", "updatedAt", "targets", "result", "error")) {
            if (record.has(field)) {
                status.add(field, record.get(field).deepCopy());
            }
        }
        return status;
    }

    private static String binding(String kind, String identity, List<String> targets) {
        var digest = CodexStorageDatabase.digest();
        digest.update((kind + "\n" + identity + "\n" + String.join("\n", targets.stream().distinct().sorted().toList())).getBytes(StandardCharsets.UTF_8));
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    private void pruneTerminalDetails() throws IOException {
        Instant cutoff = Instant.now().minus(java.time.Duration.ofDays(30));
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".json")).toList()) {
                JsonObject record = read(file);
                if (!terminal(record) || record.has("tombstone") || !Instant.parse(record.get("updatedAt").getAsString()).isBefore(cutoff)) {
                    continue;
                }
                for (String field : List.of("files", "stores", "before", "rolloutNames", "databaseIdentity", "contentDigest", "canonicalRoot", "physicalRoot")) {
                    record.remove(field);
                }
                record.add("checkpoints", new JsonObject());
                record.addProperty("tombstone", true);
                // Keep identity, binding, original family and outcome indefinitely for replay and admission.
                save(record);
            }
        }
    }

    private JsonObject read(Path file) throws IOException {
        try {
            if (Files.isSymbolicLink(file) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 4 * 1024 * 1024) {
                throw new IOException("MAINTENANCE_JOURNAL_INVALID");
            }
            JsonObject value = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            if (value.get("version").getAsInt() != 1 || !file.getFileName().toString().equals(value.get("operationId").getAsString() + ".json")
                    || !value.has("rootIdentity") || !value.has("binding") || !value.has("targets") || !value.has("checkpoints")
                    || !Set.of("ACCEPTED", "PREPARING", "COMMITTING", "RECONCILIATION_REQUIRED", "RECONCILING").contains(value.get("state").getAsString()) && !terminal(value)) {
                throw new IOException("MAINTENANCE_JOURNAL_INVALID");
            }
            validateId(value.get("operationId").getAsString());
            return value;
        } catch (RuntimeException error) {
            throw new IOException("MAINTENANCE_JOURNAL_INVALID", error);
        }
    }

    private void checkDirectory() throws IOException {
        if (Files.isSymbolicLink(directory) || Files.isSymbolicLink(directory.getParent())
                || !Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
        }
    }

    private static void validateId(String id) throws IOException {
        try {
            if (id == null || !UUID.fromString(id).toString().equals(id)) {
                throw new IllegalArgumentException();
            }
        } catch (RuntimeException error) {
            throw new IOException("INVALID_OPERATION_ID", error);
        }
    }
}
