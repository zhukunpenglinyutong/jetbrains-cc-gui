package com.github.claudecodegui.storage;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import com.google.gson.JsonObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.function.Consumer;

final class CodexStorageFixture {
    final Path root;
    final Path coordination;
    final CodexStoragePaths paths;
    final AiDataProcessGate gate;

    CodexStorageFixture(Path base) throws Exception {
        root = Files.createDirectory(base.resolve("codex")).toRealPath();
        coordination = base.resolve("coordination");
        gate = new AiDataProcessGate(new AiDataMigrationCoordinator(coordination));
        paths = new CodexStoragePaths(root);
        for (String name : CodexStoragePaths.DATABASES) {
            String resource = "/codex-storage/schema/" + name.replace(".sqlite", ".sql");
            String ddl;
            try (var stream = getClass().getResourceAsStream(resource)) {
                ddl = new String(java.util.Objects.requireNonNull(stream).readAllBytes(), StandardCharsets.UTF_8);
            }
            try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + root.resolve(name)); Statement statement = connection.createStatement()) {
                for (String sql : ddl.split(";\\s*\n\\s*\n")) {
                    if (!sql.isBlank()) {
                        statement.execute(sql);
                    }
                }
            }
        }
    }

    CodexStorageMaintenance service() {
        return service(checkpoint -> { });
    }

    CodexStorageMaintenance service(Consumer<String> observer) {
        return new CodexStorageMaintenance(paths, gate, coordination, path -> Long.MAX_VALUE, true, observer);
    }

    void thread(String id, String cwd, int payloadSize) throws Exception {
        try (Connection connection = CodexStorageDatabase.open(root.resolve("state_5.sqlite"), false);
             PreparedStatement statement = connection.prepareStatement(
                     "INSERT INTO threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,history_mode)"
                             + " VALUES(?, '', 10, 20, 'cli', 'openai', ?, ?, 'read-only', 'never', 'paginated')")) {
            statement.setString(1, id);
            statement.setString(2, cwd);
            statement.setString(3, "Title " + id);
            statement.executeUpdate();
        }
        try (Connection connection = CodexStorageDatabase.open(root.resolve(CodexStoragePaths.HISTORY_DATABASE), false)) {
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO thread_history_projection_state VALUES(?,0,2)")) {
                statement.setString(1, id);
                statement.executeUpdate();
            }
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO thread_turns(thread_id,turn_id,rollout_ordinal,status) VALUES(?,'turn',0,'completed')")) {
                statement.setString(1, id);
                statement.executeUpdate();
            }
            try (PreparedStatement statement = connection.prepareStatement(
                    "INSERT INTO thread_items(thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json) VALUES(?,'turn','item',1,1000,?)")) {
                statement.setString(1, id);
                statement.setString(2, "{\"type\":\"agentMessage\",\"text\":\"" + "x".repeat(payloadSize) + "\"}");
                statement.executeUpdate();
            }
        }
    }

    Path rollout(String id, String parent, boolean archived) throws Exception {
        Path directory = Files.createDirectories(root.resolve(archived ? "archived_sessions" : "sessions"));
        Path file = directory.resolve("rollout-2026-10-16T00-00-00-" + id + ".jsonl");
        JsonObject meta = new JsonObject();
        meta.addProperty("type", "session_meta");
        JsonObject payload = new JsonObject();
        payload.addProperty("id", id);
        payload.addProperty("cwd", "/file-project");
        if (parent != null) {
            JsonObject spawn = new JsonObject();
            spawn.addProperty("parent_thread_id", parent);
            JsonObject subagent = new JsonObject();
            subagent.add("thread_spawn", spawn);
            JsonObject source = new JsonObject();
            source.add("subagent", subagent);
            payload.add("source", source);
        }
        meta.add("payload", payload);
        Files.writeString(file, meta + "\n{\"type\":\"message\",\"text\":\"file history\"}\n", StandardCharsets.UTF_8);
        return file;
    }

    long count(String database, String table) throws Exception {
        try (Connection connection = CodexStorageDatabase.open(root.resolve(database), true)) {
            return CodexStorageDatabase.scalar(connection, "SELECT count(*) FROM " + table);
        }
    }

    void sql(String database, String sql) throws Exception {
        try (Connection connection = CodexStorageDatabase.open(root.resolve(database), false)) {
            CodexStorageDatabase.execute(connection, sql);
        }
    }
}
