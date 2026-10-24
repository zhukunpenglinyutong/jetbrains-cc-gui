package com.github.claudecodegui.storage;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Metadata-only cross-project inventory and bounded, on-demand content pages. */
public final class CodexStorageInventory {
    private static final Logger LOG = Logger.getInstance(CodexStorageInventory.class);
    private static final Gson GSON = new Gson();
    private static final int RECORD_CHARS = 32 * 1024;
    private static final Pattern ROLLOUT_ID = Pattern.compile(".*-([a-fA-F0-9]{8}-[a-fA-F0-9-]{27,36})\\.jsonl", Pattern.CASE_INSENSITIVE);
    private final CodexStoragePaths paths;
    private final Map<String, String> customTitles;

    public CodexStorageInventory(CodexStoragePaths paths) {
        this(paths, Map.of());
    }

    public CodexStorageInventory(CodexStoragePaths paths, Map<String, String> customTitles) {
        this.paths = paths;
        this.customTitles = Map.copyOf(customTitles);
    }

    public static final class Entry {
        public String sessionId;
        public String title = "";
        public String cwd = "";
        public String storageMode = "file";
        public String parentId;
        public boolean subagent;
        public long lastTimestamp;
        public long firstTimestamp;
        public long fileSize;
        public boolean archived;
        public boolean running;
        public boolean readable;
        public String metadataWarning;
        transient String declaredRollout;
        public String deletionUnavailableReason;
        final transient List<Path> files = new ArrayList<>();
    }

    public record Snapshot(Map<String, Entry> sessions, List<String> errors) { }

    public Snapshot snapshot() throws IOException {
        paths.revalidate();
        Map<String, Entry> entries = new LinkedHashMap<>();
        List<String> errors = new ArrayList<>();
        readState(entries, errors);
        readHistoryIds(entries, errors);
        readRollouts(entries, errors, "sessions");
        readRollouts(entries, errors, "archived_sessions");
        Set<String> running = new LinkedHashSet<>(CodexStorageActivity.runningSessionIds());
        Set<String> occupied = new LinkedHashSet<>();
        try {
            occupied.addAll(CodexStorageWriterLease.occupiedSessions(paths));
        } catch (IOException error) {
            errors.add("thread-writer-locks: READ_FAILED");
        }
        String unavailable = deletionUnavailableReason();
        for (Entry entry : entries.values()) {
            entry.running = running.contains(entry.sessionId);
            // Match history display names before title search and pagination are applied.
            String customTitle = customTitles.get(entry.sessionId);
            if (customTitle != null && !customTitle.isBlank()) {
                entry.title = customTitle;
            }
            if (entry.title.isBlank()) {
                entry.title = entry.sessionId;
            }
            if (entry.running) {
                entry.deletionUnavailableReason = "SESSION_RUNNING";
            } else if (occupied.contains(entry.sessionId)) {
                // An external client can retain its writer lease while idle. It is unsafe to delete,
                // but the lock alone does not prove that a model turn is executing.
                entry.deletionUnavailableReason = "SESSION_WRITER_BUSY";
            } else if (!errors.isEmpty()) {
                entry.deletionUnavailableReason = "INVENTORY_INCOMPLETE";
            } else {
                entry.deletionUnavailableReason = unavailable;
            }
        }
        paths.revalidate();
        return new Snapshot(entries, errors);
    }

    private String deletionUnavailableReason() {
        if (!CodexStoragePlatform.supportsDeletion(paths)) {
            return "MAINTENANCE_PLATFORM_UNSUPPORTED";
        }
        try (var files = Files.list(paths.root())) {
            for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".sqlite")).toList()) {
                String name = file.getFileName().toString();
                if (!CodexStoragePaths.DATABASES.contains(name)) {
                    return "DATABASE_DEPENDENCY_UNSUPPORTED";
                }
                try (Connection connection = CodexStorageDatabase.open(paths.existingFile(file), true)) {
                    CodexStorageDatabase.requireSupported(connection, name);
                }
            }
            return null;
        } catch (IOException | SQLException error) {
            return CodexStorageMaintenance.errorCode(error);
        }
    }

    public JsonObject list(String cursor, int limit, String query, String sort) throws IOException {
        return list(cursor, limit, query, sort, "all");
    }

    public JsonObject list(String cursor, int limit, String query, String sort, String filter) throws IOException {
        return list(cursor, null, limit, query, sort, filter);
    }

    public JsonObject listPage(int page, int limit, String query, String sort, String filter) throws IOException {
        if (page < 1) {
            throw new IOException("INVALID_STORAGE_REQUEST");
        }
        return list(null, page, limit, query, sort, filter);
    }

    private JsonObject list(String cursor, Integer page, int limit, String query, String sort, String filter) throws IOException {
        Snapshot snapshot = snapshot();
        // Resolve relationships against the complete inventory, before filtering and pagination.
        Map<String, Entry> identities = new LinkedHashMap<>();
        Map<String, Integer> childCounts = new LinkedHashMap<>();
        for (Entry entry : snapshot.sessions().values()) {
            identities.put(entry.sessionId.toLowerCase(Locale.ROOT), entry);
            if (!entry.files.isEmpty() && entry.parentId != null && !entry.parentId.equalsIgnoreCase(entry.sessionId)) {
                childCounts.merge(entry.parentId.toLowerCase(Locale.ROOT), 1, Integer::sum);
            }
        }
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        List<Entry> entries = snapshot.sessions().values().stream()
                .filter(entry -> !entry.files.isEmpty())
                .filter(entry -> switch (filter == null ? "all" : filter) {
                    case "database" -> entry.storageMode.equals("database");
                    case "file" -> entry.storageMode.equals("file");
                    case "archived" -> entry.archived;
                    case "running" -> entry.running;
                    case "idle" -> !entry.running && !"SESSION_WRITER_BUSY".equals(entry.deletionUnavailableReason);
                    default -> true;
                })
                .filter(entry -> needle.isEmpty() || (entry.title + "\n" + entry.cwd + "\n" + entry.sessionId).toLowerCase(Locale.ROOT).contains(needle))
                .sorted("size".equals(sort)
                        ? Comparator.comparingLong((Entry entry) -> entry.fileSize).reversed().thenComparing(entry -> entry.sessionId)
                        : Comparator.comparingLong((Entry entry) -> entry.lastTimestamp).reversed().thenComparing(entry -> entry.sessionId))
                .toList();
        String generation = generation(entries, needle, sort + ":" + filter);
        int pageSize = boundedLimit(limit);
        int lastPage = Math.max(1, (int) ((entries.size() + (long) pageSize - 1) / pageSize));
        int offset = page == null ? parseCursor(cursor, generation) : (Math.min(page, lastPage) - 1) * pageSize;
        if (offset > entries.size()) {
            throw new IOException("CURSOR_EXPIRED");
        }
        int end = Math.min(entries.size(), offset + pageSize);
        JsonObject result = new JsonObject();
        // Host-only file paths must not be serialized as editable client inputs.
        JsonArray rows = new JsonArray();
        for (Entry entry : entries.subList(offset, end)) {
            JsonObject row = GSON.toJsonTree(entry).getAsJsonObject();
            row.remove("files");
            row.addProperty("childCount", childCounts.getOrDefault(entry.sessionId.toLowerCase(Locale.ROOT), 0));
            if (entry.parentId != null) {
                Entry parent = identities.get(entry.parentId.toLowerCase(Locale.ROOT));
                row.addProperty("parentAvailable", parent != null && !parent.files.isEmpty());
                if (parent != null) {
                    row.addProperty("parentId", parent.sessionId);
                    row.addProperty("parentTitle", parent.title);
                    row.addProperty("parentIsSubagent", parent.subagent);
                }
            }
            rows.add(row);
        }
        result.add("sessions", rows);
        result.addProperty("total", entries.size());
        result.addProperty("page", offset / pageSize + 1);
        result.addProperty("pageSize", pageSize);
        result.addProperty("hasMore", end < entries.size());
        if (end < entries.size()) {
            result.addProperty("nextCursor", encodeCursor(generation, end));
        }
        result.addProperty("complete", snapshot.errors().isEmpty());
        result.add("errors", GSON.toJsonTree(snapshot.errors()));
        return result;
    }

    public JsonObject usage(BooleanSupplier cancelled) throws IOException {
        paths.revalidate();
        Map<String, Long> sizes = new LinkedHashMap<>();
        List<String> skipped = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        Set<Object> physicalFiles = new LinkedHashSet<>();
        Files.walkFileTree(paths.root(), new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes) throws IOException {
                if (cancelled.getAsBoolean()) {
                    throw new IOException("SCAN_CANCELLED");
                }
                if (!directory.toRealPath().equals(directory)) {
                    skipped.add(paths.root().relativize(directory).toString());
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                if (cancelled.getAsBoolean()) {
                    throw new IOException("SCAN_CANCELLED");
                }
                Path relative = paths.root().relativize(file);
                if (attributes.isSymbolicLink() || !attributes.isRegularFile()) {
                    skipped.add(relative.toString());
                } else if (physicalFiles.add(CodexStoragePaths.physicalFileKey(file, attributes))) {
                    String top = relative.getName(0).toString();
                    String category = top.equals("sessions") || top.equals("archived_sessions") ? "sessions"
                            : top.startsWith("thread_history_") ? "historyDatabase"
                            : top.equals(".tmp") ? "temporary" : top.equals("log") || top.equals("logs") ? "logs"
                            : top.equals("pets") || top.equals("skills") ? "protectedAssets" : "other";
                    sizes.merge(category, attributes.size(), Long::sum);
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException error) {
                errors.add(paths.root().relativize(file) + ": READ_FAILED");
                return FileVisitResult.CONTINUE;
            }
        });
        paths.revalidate();
        JsonObject result = new JsonObject();
        result.addProperty("canonicalRoot", paths.canonical().toString());
        result.addProperty("physicalRoot", paths.root().toString());
        result.addProperty("scannedAt", Instant.now().toString());
        result.addProperty("logicalBytes", sizes.values().stream().mapToLong(Long::longValue).sum());
        result.add("categories", GSON.toJsonTree(sizes));
        result.add("skippedLinks", GSON.toJsonTree(skipped));
        result.add("errors", GSON.toJsonTree(errors));
        result.addProperty("complete", errors.isEmpty());
        return result;
    }

    public Path sessionFile(String sessionId) throws IOException {
        CodexStoragePaths.requireSessionId(sessionId);
        Entry entry = snapshot().sessions().get(sessionId);
        if (entry == null || entry.files.isEmpty()) {
            throw new IOException("SESSION_FILE_NOT_FOUND");
        }
        paths.revalidate();
        return paths.existingFile(entry.files.get(0));
    }

    public JsonObject content(String sessionId, String cursor, int limit) throws IOException, SQLException {
        CodexStoragePaths.requireSessionId(sessionId);
        Snapshot snapshot = snapshot();
        Entry entry = snapshot.sessions().get(sessionId);
        if (entry == null) {
            throw new IOException("SESSION_NOT_FOUND");
        }
        if (!"file".equals(entry.storageMode) && (cursor == null || !cursor.startsWith("file:"))
                && Files.isRegularFile(paths.root().resolve(CodexStoragePaths.HISTORY_DATABASE))) {
            JsonObject page = databaseContent(sessionId, cursor, boundedLimit(limit));
            // Projection metadata can outlive its materialized items. Existing JSONL remains readable.
            if (!page.getAsJsonArray("records").isEmpty() || cursor != null || entry.files.isEmpty()) {
                return page;
            }
        }
        if (entry.files.isEmpty()) {
            throw new IOException("SESSION_CONTENT_UNAVAILABLE");
        }
        Path file = paths.existingFile(entry.files.get(0));
        long offset = numericCursor(cursor, "file:");
        JsonArray records = new JsonArray();
        boolean more;
        try (RandomAccessFile input = new RandomAccessFile(file.toFile(), "r")) {
            if (offset > input.length()) {
                throw new IOException("CURSOR_EXPIRED");
            }
            input.seek(offset);
            int readBytes = 0;
            while (records.size() < boundedLimit(limit) && input.getFilePointer() < input.length() && readBytes < 512 * 1024) {
                java.io.ByteArrayOutputStream prefix = new java.io.ByteArrayOutputStream();
                int value;
                int scanned = 0;
                boolean ended = false;
                while (scanned < 64 * 1024 && (value = input.read()) != -1) {
                    scanned++;
                    if (value == '\n') {
                        ended = true;
                        break;
                    }
                    if (prefix.size() < RECORD_CHARS) {
                        prefix.write(value);
                    }
                }
                readBytes += scanned;
                JsonObject record = new JsonObject();
                record.addProperty("text", prefix.toString(StandardCharsets.UTF_8));
                record.addProperty("truncated", !ended || scanned > RECORD_CHARS);
                records.add(record);
            }
            offset = input.getFilePointer();
            more = offset < input.length();
        }
        return contentResult(sessionId, records, more, "file:" + offset);
    }

    private JsonObject databaseContent(String sessionId, String cursor, int limit) throws SQLException, IOException {
        long offset = numericCursor(cursor, "db:");
        JsonArray records = new JsonArray();
        Path file = paths.existingFile(paths.root().resolve(CodexStoragePaths.HISTORY_DATABASE));
        try (Connection connection = CodexStorageDatabase.open(file, true)) {
            List<String> tables = CodexStorageDatabase.tables(connection);
            List<String> sources = new ArrayList<>();
            for (String table : List.of("thread_items", "thread_realtime_items")) {
                if (tables.contains(table) && CodexStorageDatabase.columns(connection, table).containsAll(List.of("thread_id", "item_json", "rollout_ordinal"))) {
                    sources.add("SELECT rollout_ordinal,substr(item_json,1," + (RECORD_CHARS + 1) + ") AS body,length(item_json) AS size FROM " + table + " WHERE thread_id=?");
                }
            }
            if (sources.isEmpty()) {
                throw new IOException("DATABASE_SCHEMA_UNSUPPORTED");
            }
            String sql = "SELECT body,size FROM (" + String.join(" UNION ALL ", sources) + ") ORDER BY rollout_ordinal LIMIT ? OFFSET ?";
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                int parameter = 1;
                for (int i = 0; i < sources.size(); i++) {
                    statement.setString(parameter++, sessionId);
                }
                statement.setInt(parameter++, limit + 1);
                statement.setLong(parameter, offset);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        JsonObject record = new JsonObject();
                        String body = rows.getString(1);
                        record.addProperty("text", body.length() > RECORD_CHARS ? body.substring(0, RECORD_CHARS) : body);
                        record.addProperty("truncated", rows.getLong(2) > RECORD_CHARS);
                        records.add(record);
                    }
                }
            }
        }
        boolean more = records.size() > limit;
        if (more) {
            records.remove(records.size() - 1);
        }
        return contentResult(sessionId, records, more, "db:" + (offset + records.size()));
    }

    private void readState(Map<String, Entry> entries, List<String> errors) throws IOException {
        try (var files = Files.list(paths.root())) {
            for (Path file : files.filter(path -> path.getFileName().toString().matches("state_\\d+\\.sqlite")).sorted().toList()) {
                try (Connection connection = CodexStorageDatabase.open(paths.existingFile(file), true)) {
                    Set<String> columns = new LinkedHashSet<>(CodexStorageDatabase.columns(connection, "threads"));
                    if (!columns.contains("id")) {
                        throw new IOException("DATABASE_SCHEMA_UNSUPPORTED");
                    }
                    String sql = "SELECT id," + column(columns, "title", "''") + "," + column(columns, "cwd", "''") + ","
                            + column(columns, "history_mode", "'legacy'") + "," + column(columns, "archived", "0") + ","
                            + column(columns, "created_at_ms", columns.contains("created_at") ? "created_at*1000" : "0") + ","
                            + column(columns, "updated_at_ms", columns.contains("updated_at") ? "updated_at*1000" : "0") + ","
                            + column(columns, "rollout_path", "''") + " FROM threads";
                    try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(sql)) {
                        while (rows.next()) {
                            Entry entry = entries.computeIfAbsent(rows.getString(1), CodexStorageInventory::entry);
                            entry.title = displayTitle(rows.getString(2));
                            entry.cwd = rows.getString(3) == null ? "" : rows.getString(3);
                            entry.storageMode = "paginated".equals(rows.getString(4)) ? "database" : "file";
                            entry.archived = rows.getBoolean(5);
                            entry.firstTimestamp = rows.getLong(6);
                            entry.lastTimestamp = rows.getLong(7);
                            entry.declaredRollout = rows.getString(8);
                        }
                    }
                    readSpawnEdges(connection, entries);
                } catch (IOException | SQLException error) {
                    errors.add(readError(file, error));
                }
            }
        }
    }

    private static void readSpawnEdges(Connection connection, Map<String, Entry> entries) throws SQLException, IOException {
        if (!CodexStorageDatabase.columns(connection, "thread_spawn_edges").containsAll(List.of("child_thread_id", "parent_thread_id"))) {
            return;
        }
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(
                "SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges")) {
            while (rows.next()) {
                String child = rows.getString(1);
                String parent = rows.getString(2);
                CodexStoragePaths.requireSessionId(child);
                CodexStoragePaths.requireSessionId(parent);
                Entry entry = entries.computeIfAbsent(child, CodexStorageInventory::entry);
                entry.subagent = true;
                if (!child.equalsIgnoreCase(parent)) {
                    entry.parentId = parent;
                }
            }
        }
    }

    private void readHistoryIds(Map<String, Entry> entries, List<String> errors) {
        Path file = paths.root().resolve(CodexStoragePaths.HISTORY_DATABASE);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try (Connection connection = CodexStorageDatabase.open(paths.existingFile(file), true)) {
            for (String table : CodexStorageDatabase.tables(connection)) {
                if (!CodexStorageDatabase.columns(connection, table).contains("thread_id")) {
                    continue;
                }
                try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(
                        "SELECT DISTINCT thread_id FROM " + CodexStorageDatabase.quote(table))) {
                    while (rows.next()) {
                        String id = rows.getString(1);
                        CodexStoragePaths.requireSessionId(id);
                        Entry entry = entries.computeIfAbsent(id, CodexStorageInventory::entry);
                        entry.storageMode = "database";
                        entry.readable = true;
                    }
                }
            }
        } catch (IOException | SQLException error) {
            errors.add(readError(file, error));
        }
    }

    private static String readError(Path file, Exception error) {
        LOG.warn("[CodexStorage] Could not read " + file.getFileName(), error);
        String code = CodexStorageMaintenance.errorCode(error);
        return file.getFileName() + ": " + ("STORAGE_OPERATION_FAILED".equals(code) ? "READ_FAILED" : code);
    }

    private void readRollouts(Map<String, Entry> entries, List<String> errors, String directory) throws IOException {
        Path root = paths.root().resolve(directory);
        BasicFileAttributes rootAttributes;
        try {
            rootAttributes = Files.readAttributes(root, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (java.nio.file.NoSuchFileException ignored) {
            return;
        } catch (IOException error) {
            errors.add(directory + ": READ_FAILED");
            return;
        }
        if (!rootAttributes.isDirectory()) {
            errors.add(directory + ": DIRECTORY_UNAVAILABLE");
            return;
        }
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path path, BasicFileAttributes attributes) throws IOException {
                if (!path.toRealPath().equals(path)) {
                    errors.add(directory + ": LINK_SKIPPED");
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path path, BasicFileAttributes attributes) {
                if (!attributes.isRegularFile() || !path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".jsonl")) {
                    if (attributes.isSymbolicLink() || attributes.isOther()) {
                        errors.add(directory + ": LINK_SKIPPED");
                    }
                    return FileVisitResult.CONTINUE;
                }
                try {
                    paths.existingFile(path);
                    JsonObject meta;
                    try {
                        meta = readMetadata(path);
                    } catch (IOException | RuntimeException error) {
                        // A damaged header is not a missing file. Its filename still protects the history.
                        meta = new JsonObject();
                    }
                    String id = string(meta, "id");
                    Matcher filenameId = ROLLOUT_ID.matcher(path.getFileName().toString());
                    if (id != null && filenameId.matches() && !id.equalsIgnoreCase(filenameId.group(1))) {
                        throw new IOException("SESSION_IDENTITY_MISMATCH");
                    }
                    if (id == null) {
                        Matcher match = ROLLOUT_ID.matcher(path.getFileName().toString());
                        if (!match.matches()) {
                            throw new IOException("SESSION_METADATA_UNAVAILABLE");
                        }
                        id = match.group(1);
                    }
                    CodexStoragePaths.requireSessionId(id);
                    String observedId = id;
                    id = entries.keySet().stream().filter(known -> known.equalsIgnoreCase(observedId)).findFirst().orElse(id);
                    Entry entry = entries.computeIfAbsent(id, CodexStorageInventory::entry);
                    entry.readable |= attributes.size() > 0;
                    if (string(meta, "id") == null) {
                        entry.metadataWarning = "SESSION_METADATA_UNAVAILABLE";
                    }
                    entry.files.add(path);
                    entry.fileSize += attributes.size();
                    entry.lastTimestamp = Math.max(entry.lastTimestamp, attributes.lastModifiedTime().toMillis());
                    if (entry.cwd.isBlank()) {
                        entry.cwd = string(meta, "cwd") == null ? "" : string(meta, "cwd");
                    }
                    if (entry.firstTimestamp == 0 && string(meta, "timestamp") != null) {
                        try {
                            entry.firstTimestamp = Instant.parse(string(meta, "timestamp")).toEpochMilli();
                        } catch (RuntimeException ignored) {
                            entry.firstTimestamp = attributes.creationTime().toMillis();
                        }
                    }
                    String parent = parentId(meta);
                    JsonElement source = meta.get("source");
                    entry.subagent |= parent != null || source != null && source.isJsonObject() && source.getAsJsonObject().has("subagent");
                    // State edges are also authoritative for deletion; duplicate rollout headers must not erase them.
                    if (entry.parentId == null && parent != null && !parent.equalsIgnoreCase(entry.sessionId)) {
                        entry.parentId = parent;
                    }
                    entry.archived |= directory.equals("archived_sessions");
                    if (entry.title.isBlank()) {
                        entry.title = rolloutTitle(path);
                    }
                } catch (IOException | RuntimeException error) {
                    errors.add(path.getFileName() + ": READ_FAILED");
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFileFailed(Path file, IOException error) {
                errors.add(file.getFileName() + ": READ_FAILED");
                return FileVisitResult.CONTINUE;
            }
        });
    }

    static JsonObject readMetadata(Path file) throws IOException {
        try (RandomAccessFile input = new RandomAccessFile(file.toFile(), "r")) {
            byte[] prefix = new byte[(int) Math.min(64 * 1024, input.length())];
            input.readFully(prefix);
            String text = new String(prefix, StandardCharsets.UTF_8);
            int newline = text.indexOf('\n');
            if (newline < 0 && input.length() > prefix.length) {
                return new JsonObject();
            }
            JsonObject root = JsonParser.parseString(newline < 0 ? text : text.substring(0, newline)).getAsJsonObject();
            return "session_meta".equals(string(root, "type")) && root.has("payload") && root.get("payload").isJsonObject()
                    ? root.getAsJsonObject("payload") : new JsonObject();
        }
    }

    /** Ignore injected setup text and inspect only a bounded prefix, never an entire rollout. */
    private static String rolloutTitle(Path file) {
        try (RandomAccessFile input = new RandomAccessFile(file.toFile(), "r")) {
            byte[] prefix = new byte[(int) Math.min(512 * 1024, input.length())];
            input.readFully(prefix);
            for (String line : new String(prefix, StandardCharsets.UTF_8).split("\n")) {
                try {
                    JsonObject record = JsonParser.parseString(line).getAsJsonObject();
                    if (!record.has("payload") || !record.get("payload").isJsonObject()) {
                        continue;
                    }
                    JsonObject payload = record.getAsJsonObject("payload");
                    if ("user_message".equals(string(payload, "type"))) {
                        String title = displayTitle(string(payload, "message"));
                        if (!title.isBlank()) {
                            return title;
                        }
                    }
                    if ("user".equals(string(payload, "role")) && payload.has("content") && payload.get("content").isJsonArray()) {
                        for (JsonElement part : payload.getAsJsonArray("content")) {
                            if (part.isJsonObject()) {
                                String title = displayTitle(string(part.getAsJsonObject(), "text"));
                                if (!title.isBlank()) {
                                    return title;
                                }
                            }
                        }
                    }
                } catch (RuntimeException ignored) {
                    // Partial trailing records and individual damaged records do not invalidate coverage.
                }
            }
        } catch (IOException ignored) {
            // File identity remains known even when a display title cannot be read.
        }
        return "";
    }

    static String displayTitle(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        String value = raw.strip();
        for (String tag : List.of("agents-instructions", "environment_context")) {
            value = value.replaceAll("(?s)<" + tag + ">.*?</" + tag + ">", "").strip();
        }
        if (value.startsWith("<agents-instructions>") || value.startsWith("<environment_context>")
                || value.startsWith("# AGENTS.md instructions") || value.startsWith("# Global Instructions")) {
            return "";
        }
        int newline = value.indexOf('\n');
        return value.substring(0, Math.min(newline < 0 ? value.length() : newline, 160)).strip();
    }

    private static String parentId(JsonObject meta) {
        String direct = string(meta, "parent_thread_id");
        if (direct != null && !direct.isBlank()) {
            return direct;
        }
        JsonObject current = meta;
        for (String name : List.of("source", "subagent", "thread_spawn")) {
            if (!current.has(name) || !current.get(name).isJsonObject()) {
                return null;
            }
            current = current.getAsJsonObject(name);
        }
        String parent = string(current, "parent_thread_id");
        return parent == null || parent.isBlank() ? null : parent;
    }

    private static Entry entry(String id) {
        Entry entry = new Entry();
        entry.sessionId = id;
        return entry;
    }

    private static String column(Set<String> columns, String name, String fallback) {
        return columns.contains(name) ? "COALESCE(" + CodexStorageDatabase.quote(name) + "," + fallback + ")" : fallback;
    }

    private static JsonObject contentResult(String id, JsonArray records, boolean more, String cursor) {
        JsonObject result = new JsonObject();
        result.addProperty("sessionId", id);
        result.add("records", records);
        result.addProperty("hasMore", more);
        if (more) {
            result.addProperty("nextCursor", cursor);
        }
        return result;
    }

    private static String generation(List<Entry> entries, String query, String sort) {
        var digest = CodexStorageDatabase.digest();
        digest.update((query + "\n" + sort).getBytes(StandardCharsets.UTF_8));
        for (Entry entry : entries) {
            // Growing the current rollout must not invalidate paging when membership/order is unchanged.
            digest.update((entry.sessionId + "\n").getBytes(StandardCharsets.UTF_8));
        }
        return HexFormat.of().formatHex(digest.digest()).substring(0, 24);
    }

    private static String encodeCursor(String generation, int offset) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString((generation + ":" + offset).getBytes(StandardCharsets.UTF_8));
    }

    private static int parseCursor(String cursor, String generation) throws IOException {
        if (cursor == null || cursor.isBlank()) {
            return 0;
        }
        try {
            if (cursor.length() > 256) {
                throw new IllegalArgumentException();
            }
            String[] parts = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8).split(":");
            int offset = Integer.parseInt(parts[1]);
            if (parts.length != 2 || !parts[0].equals(generation) || offset < 0) {
                throw new IllegalArgumentException();
            }
            return offset;
        } catch (RuntimeException error) {
            throw new IOException("CURSOR_EXPIRED", error);
        }
    }

    private static long numericCursor(String cursor, String prefix) throws IOException {
        if (cursor == null || cursor.isBlank()) {
            return 0;
        }
        try {
            if (!cursor.startsWith(prefix) || cursor.length() > 32) {
                throw new IllegalArgumentException();
            }
            long value = Long.parseLong(cursor.substring(prefix.length()));
            if (value < 0) {
                throw new IllegalArgumentException();
            }
            return value;
        } catch (RuntimeException error) {
            throw new IOException("CURSOR_EXPIRED", error);
        }
    }

    private static int boundedLimit(int limit) {
        return Math.max(1, Math.min(100, limit));
    }

    private static String string(JsonObject object, String name) {
        JsonElement value = object.get(name);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString() : null;
    }
}
