package com.github.claudecodegui.storage;

import com.google.gson.JsonObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Complete supported-store coverage, kept separate from UI and operation coordination. */
final class CodexStorageStores implements AutoCloseable {
    private final CodexStoragePaths paths;
    private final Map<String, Connection> connections = new LinkedHashMap<>();
    private final Map<String, String> identities = new LinkedHashMap<>();

    CodexStorageStores(CodexStoragePaths paths) throws IOException, SQLException {
        this(paths, false);
    }

    CodexStorageStores(CodexStoragePaths paths, boolean historyOnly) throws IOException, SQLException {
        this.paths = paths;
        try {
            try (var files = Files.list(paths.root())) {
                for (Path file : files.filter(path -> path.getFileName().toString().endsWith(".sqlite")).sorted().toList()) {
                    String name = file.getFileName().toString();
                    if (historyOnly && !name.equals(CodexStoragePaths.HISTORY_DATABASE)) {
                        continue;
                    }
                    if (!CodexStoragePaths.DATABASES.contains(name)) {
                        throw new IOException("DATABASE_DEPENDENCY_UNSUPPORTED");
                    }
                    Path real = paths.existingFile(file);
                    Connection connection = CodexStorageDatabase.openForMutation(real);
                    connections.put(name, connection);
                    identities.put(name, CodexStoragePaths.identity(real));
                    // Reserve writes and a consistent snapshot without excluding idle native WAL connections.
                    connection.setAutoCommit(false);
                    CodexStorageDatabase.requireSupported(connection, name);
                    CodexStorageDatabase.checkIntegrity(connection);
                }
            }
        } catch (IOException | SQLException | RuntimeException error) {
            close();
            throw error;
        }
    }

    static CodexStorageStores forHistoryDeletion(CodexStoragePaths paths) throws IOException, SQLException {
        return new CodexStorageStores(paths, false);
    }

    Connection history() throws IOException {
        Connection connection = connections.get(CodexStoragePaths.HISTORY_DATABASE);
        if (connection == null) {
            throw new IOException("DATABASE_NOT_FOUND");
        }
        return connection;
    }

    Map<String, String> identities() {
        return identities;
    }

    /** Adds state-only descendants to file-derived descendants, without guessing parentage from names. */
    Set<String> family(Collection<String> selected, CodexStorageInventory.Snapshot inventory) throws SQLException, IOException {
        Set<String> family = new LinkedHashSet<>(selected);
        Map<String, String> parents = new LinkedHashMap<>();
        for (var entry : inventory.sessions().values()) {
            if (entry.parentId != null) {
                parents.put(entry.sessionId, entry.parentId);
            }
        }
        Connection state = connections.get("state_5.sqlite");
        if (state != null) {
            try (Statement statement = state.createStatement(); ResultSet rows = statement.executeQuery("SELECT child_thread_id,parent_thread_id FROM thread_spawn_edges")) {
                while (rows.next()) {
                    parents.put(rows.getString(1), rows.getString(2));
                }
            }
        }
        boolean changed;
        do {
            changed = false;
            for (var parent : parents.entrySet()) {
                if (family.contains(parent.getValue())) {
                    changed |= family.add(parent.getKey());
                }
            }
        } while (changed);
        for (String id : family) {
            CodexStoragePaths.requireSessionId(id);
        }
        return family;
    }

    void preflightDependencies(Collection<String> ids) throws SQLException, IOException {
        Connection memories = connections.get("memories_1.sqlite");
        if (memories != null) {
            // The installed schema does not define ownership semantics for jobs.job_key.
            // Never guess whether a matching job is a shared consolidation job.
            for (String id : ids) {
                try (PreparedStatement statement = memories.prepareStatement("SELECT 1 FROM jobs WHERE job_key=? LIMIT 1")) {
                    statement.setString(1, id);
                    try (ResultSet rows = statement.executeQuery()) {
                        if (rows.next()) {
                            throw new IOException("DATABASE_DEPENDENCY_UNSUPPORTED");
                        }
                    }
                }
            }
        }
    }

    List<String> declaredRollouts(Collection<String> ids, CodexStorageInventory.Snapshot inventory) throws SQLException, IOException {
        List<String> names = new ArrayList<>();
        Connection state = connections.get("state_5.sqlite");
        if (state == null) {
            return names;
        }
        try (PreparedStatement statement = state.prepareStatement("SELECT id,rollout_path FROM threads WHERE id IN (" + placeholders(ids.size()) + ")")) {
            new OwnedQuery("threads", "", List.copyOf(ids)).bind(statement);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    String raw = rows.getString(2);
                    if (raw == null || raw.isBlank()) {
                        continue;
                    }
                    Path path = CodexStoragePaths.declaredRolloutPath(raw).normalize();
                    if (path.startsWith(paths.canonical())) {
                        path = paths.root().resolve(paths.canonical().relativize(path));
                    }
                    if (!path.startsWith(paths.root().resolve("sessions")) && !path.startsWith(paths.root().resolve("archived_sessions"))) {
                        throw new IOException("DATABASE_DEPENDENCY_UNSUPPORTED");
                    }
                    if (Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                        Path real = paths.existingFile(path);
                        var entry = inventory.sessions().get(rows.getString(1));
                        if (entry == null || !entry.files.contains(real)) {
                            throw new IOException("INVENTORY_INCOMPLETE");
                        }
                    }
                    names.add(raw);
                    names.add(raw.replace('\\', '/'));
                }
            }
        }
        return names.stream().distinct().toList();
    }

    JsonObject capture(Collection<String> ids, Collection<String> rolloutNames) throws IOException, SQLException {
        JsonObject captures = new JsonObject();
        for (var database : connections.entrySet()) {
            JsonObject capture = new JsonObject();
            capture.addProperty("identity", identities.get(database.getKey()));
            capture.addProperty("schema", CodexStorageDatabase.fingerprint(database.getValue()));
            capture.addProperty("selectedDigest", selectedDigest(database.getKey(), database.getValue(), ids, rolloutNames));
            capture.addProperty("done", false);
            captures.add(database.getKey(), capture);
        }
        return captures;
    }

    long delete(JsonObject captures, Collection<String> ids, Collection<String> rolloutNames,
                RunnableWithIo persist) throws IOException, SQLException {
        if (!captures.keySet().equals(connections.keySet())) {
            throw new IOException("STORAGE_IDENTITY_CHANGED");
        }
        long removed = 0;
        for (var database : connections.entrySet()) {
            String name = database.getKey();
            Connection connection = database.getValue();
            JsonObject capture = captures.getAsJsonObject(name);
            if (!identities.get(name).equals(capture.get("identity").getAsString())
                    || !CodexStorageDatabase.fingerprint(connection).equals(capture.get("schema").getAsString())) {
                throw new IOException("STORAGE_IDENTITY_CHANGED");
            }
            String actual = selectedDigest(name, connection, ids, rolloutNames);
            if (capture.get("done").getAsBoolean()) {
                if (!actual.equals(emptyDigest())) {
                    throw new IOException("SELECTED_DATA_CHANGED");
                }
                continue;
            }
            if (!actual.equals(capture.get("selectedDigest").getAsString()) && !actual.equals(emptyDigest())) {
                throw new IOException("SELECTED_DATA_CHANGED");
            }
            if (!actual.equals(emptyDigest())) {
                connection.setAutoCommit(false);
                try {
                    for (OwnedQuery query : queries(name, ids, rolloutNames)) {
                        try (PreparedStatement statement = connection.prepareStatement("DELETE FROM " + query.table + " WHERE " + query.predicate)) {
                            query.bind(statement);
                            removed += statement.executeUpdate();
                        }
                    }
                    CodexStorageDatabase.checkIntegrity(connection);
                    connection.commit();
                } catch (IOException | SQLException | RuntimeException error) {
                    connection.rollback();
                    throw error;
                } finally {
                    connection.setAutoCommit(true);
                }
            }
            if (!selectedDigest(name, connection, ids, rolloutNames).equals(emptyDigest())) {
                throw new IOException("DATABASE_DELETE_VERIFY_FAILED");
            }
            capture.addProperty("done", true);
            persist.run();
        }
        return removed;
    }

    private String selectedDigest(String name, Connection connection, Collection<String> ids,
                                  Collection<String> rolloutNames) throws SQLException, IOException {
        var digest = CodexStorageDatabase.digest();
        for (OwnedQuery query : queries(name, ids, rolloutNames)) {
            List<String> columns = CodexStorageDatabase.columns(connection, query.table);
            String order = String.join(",", CodexStorageDatabase.primaryKeys(connection, query.table));
            try (PreparedStatement statement = connection.prepareStatement("SELECT * FROM " + query.table + " WHERE " + query.predicate + " ORDER BY " + order)) {
                query.bind(statement);
                try (ResultSet rows = statement.executeQuery()) {
                    while (rows.next()) {
                        digest.update(query.table.getBytes(StandardCharsets.UTF_8));
                        for (int column = 1; column <= columns.size(); column++) {
                            byte[] value = rows.getBytes(column);
                            var cell = CodexStorageDatabase.digest();
                            cell.update((byte) (value == null ? 0 : 1));
                            if (value != null) {
                                cell.update(value);
                            }
                            digest.update(cell.digest());
                        }
                    }
                }
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static String emptyDigest() {
        return HexFormat.of().formatHex(CodexStorageDatabase.digest().digest());
    }

    private static List<OwnedQuery> queries(String name, Collection<String> ids, Collection<String> rolloutNames) {
        List<OwnedQuery> queries = new ArrayList<>();
        List<String> tables = switch (name) {
            case "thread_history_1.sqlite" -> List.of("thread_items", "thread_turns", "thread_realtime_items", "thread_history_projection_state");
            case "state_5.sqlite" -> List.of("guardian_review_feedback", "thread_attachments", "thread_dynamic_tools", "thread_read_receipts");
            case "goals_1.sqlite" -> List.of("thread_goal_continuation_deferrals", "thread_goals");
            case "queue_1.sqlite" -> List.of("queued_items", "queued_thread_revisions");
            case "memories_1.sqlite" -> List.of("stage1_outputs");
            case "logs_2.sqlite" -> List.of("logs");
            default -> List.of();
        };
        for (String table : tables) {
            queries.add(new OwnedQuery(table, "thread_id IN (" + placeholders(ids.size()) + ")", List.copyOf(ids)));
        }
        if (name.equals("state_5.sqlite")) {
            List<String> doubled = new ArrayList<>(ids);
            doubled.addAll(ids);
            queries.add(new OwnedQuery("thread_spawn_edges", "parent_thread_id IN (" + placeholders(ids.size())
                    + ") OR child_thread_id IN (" + placeholders(ids.size()) + ")", doubled));
            if (!rolloutNames.isEmpty()) {
                queries.add(new OwnedQuery("rollout_migration_skipped_rollouts", "rollout_path IN (" + placeholders(rolloutNames.size()) + ")", List.copyOf(rolloutNames)));
            }
            queries.add(new OwnedQuery("threads", "id IN (" + placeholders(ids.size()) + ")", List.copyOf(ids)));
        }
        return queries;
    }

    private static String placeholders(int count) {
        return String.join(",", java.util.Collections.nCopies(count, "?"));
    }

    @Override
    public void close() throws SQLException {
        SQLException failure = null;
        for (Connection connection : connections.values()) {
            try {
                connection.close();
            } catch (SQLException error) {
                failure = error;
            }
        }
        connections.clear();
        if (failure != null) {
            throw failure;
        }
    }

    @FunctionalInterface
    interface RunnableWithIo {
        void run() throws IOException;
    }

    private record OwnedQuery(String table, String predicate, List<String> parameters) {
        void bind(PreparedStatement statement) throws SQLException {
            for (int i = 0; i < parameters.size(); i++) {
                statement.setString(i + 1, parameters.get(i));
            }
        }
    }
}
