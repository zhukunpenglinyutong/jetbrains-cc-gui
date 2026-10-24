package com.github.claudecodegui.storage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.sqlite.SQLiteConfig;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/** Native WAL-aware connections. Mutation is enabled only for a reviewed complete schema fingerprint. */
public final class CodexStorageDatabase {
    private static final JsonObject SCHEMAS = loadSchemas();

    private CodexStorageDatabase() { }

    public static Connection open(Path path, boolean readOnly) throws SQLException {
        return open(path, readOnly, false);
    }

    static Connection openForMutation(Path path) throws SQLException {
        return open(path, false, true);
    }

    private static Connection open(Path path, boolean readOnly, boolean immediateTransaction) throws SQLException {
        SQLiteConfig config = new SQLiteConfig();
        config.setReadOnly(readOnly);
        if (immediateTransaction) {
            config.setTransactionMode(SQLiteConfig.TransactionMode.IMMEDIATE);
        }
        config.setBusyTimeout(200);
        config.enforceForeignKeys(true);
        config.setOpenMode(org.sqlite.SQLiteOpenMode.FULLMUTEX);
        // URI mode=rw is deliberate: maintenance must never create a missing database.
        String uri = path.toUri().toASCIIString() + (readOnly ? "?mode=ro" : "?mode=rw");
        // DriverManager discovery may have run under a different IntelliJ plugin class loader.
        // Resolve this plugin's driver directly instead of relying on a global driver registration.
        Connection connection;
        try {
            CodexSqliteNativeLibrary.initialize();
            connection = new org.sqlite.JDBC().connect("jdbc:sqlite:" + uri, config.toProperties());
        } catch (LinkageError error) {
            throw new SQLException("SQLITE_DRIVER_UNAVAILABLE", error);
        }
        try {
            if (readOnly) {
                execute(connection, "PRAGMA query_only=ON");
            }
            return connection;
        } catch (SQLException error) {
            try {
                connection.close();
            } catch (SQLException closeError) {
                error.addSuppressed(closeError);
            }
            throw error;
        }
    }

    public static String engineVersion(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery("SELECT sqlite_version()")) {
            return rows.next() ? rows.getString(1) : "";
        }
    }

    public static void requirePatchedEngine(Connection connection) throws SQLException, IOException {
        String[] parts = engineVersion(connection).split("\\.");
        if (parts.length < 3) {
            throw new IOException("SQLITE_ENGINE_UNSUPPORTED");
        }
        int major = Integer.parseInt(parts[0]);
        int minor = Integer.parseInt(parts[1]);
        int patch = Integer.parseInt(parts[2]);
        if (major < 3 || major == 3 && (minor < 51 || minor == 51 && patch < 3)) {
            throw new IOException("SQLITE_ENGINE_UNSUPPORTED");
        }
    }

    public static String fingerprint(Connection connection) throws SQLException {
        MessageDigest digest = digest();
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(
                "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")) {
            while (rows.next()) {
                String entry = rows.getString(1) + "\n" + rows.getString(2) + "\n"
                        + rows.getString(3).replaceAll("\\s+", " ").trim() + "\n";
                digest.update(entry.getBytes(StandardCharsets.UTF_8));
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    public static String requireSupported(Connection connection, String name) throws SQLException, IOException {
        requirePatchedEngine(connection);
        String actual = fingerprint(connection);
        if (!SCHEMAS.has(name) || SCHEMAS.getAsJsonArray(name).asList().stream().noneMatch(schema -> schema.getAsString().equals(actual))) {
            throw new IOException("DATABASE_SCHEMA_UNSUPPORTED");
        }
        return actual;
    }

    public static List<String> columns(Connection connection, String table) throws SQLException {
        List<String> result = new ArrayList<>();
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery("PRAGMA table_info(" + quote(table) + ")")) {
            while (rows.next()) {
                result.add(rows.getString("name"));
            }
        }
        return result;
    }

    public static List<String> tables(Connection connection) throws SQLException {
        List<String> result = new ArrayList<>();
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
            while (rows.next()) {
                result.add(rows.getString(1));
            }
        }
        return result;
    }

    public static void execute(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    public static long scalar(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getLong(1) : 0L;
        }
    }

    public static void checkIntegrity(Connection connection) throws SQLException, IOException {
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery("PRAGMA integrity_check")) {
            if (!rows.next() || !"ok".equals(rows.getString(1)) || rows.next()) {
                throw new IOException("DATABASE_INTEGRITY_FAILED");
            }
        }
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery("PRAGMA foreign_key_check")) {
            if (rows.next()) {
                throw new IOException("DATABASE_FOREIGN_KEYS_FAILED");
            }
        }
    }

    public static void lockExclusive(Connection connection) throws SQLException {
        execute(connection, "PRAGMA locking_mode=EXCLUSIVE");
        execute(connection, "BEGIN EXCLUSIVE");
        execute(connection, "COMMIT");
    }

    public static boolean checkpoint(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery("PRAGMA wal_checkpoint(TRUNCATE)")) {
            return rows.next() && rows.getInt(1) == 0;
        }
    }

    /** Streams a deterministic digest of logical rows; implicit ROWIDs are intentionally excluded. */
    public static String contentDigest(Connection connection) throws SQLException, IOException {
        MessageDigest digest = digest();
        byte[] buffer = new byte[8192];
        for (String table : tables(connection)) {
            List<String> keys = primaryKeys(connection, table);
            digest.update(table.getBytes(StandardCharsets.UTF_8));
            try (Statement statement = connection.createStatement(); ResultSet rows = statement.executeQuery(
                    "SELECT * FROM " + quote(table) + " ORDER BY " + String.join(",", keys))) {
                int count = rows.getMetaData().getColumnCount();
                while (rows.next()) {
                    for (int column = 1; column <= count; column++) {
                        // Hash logical values without parsing JSON or relying on implicit ROWIDs.
                        MessageDigest cell = digest();
                        try (InputStream stream = rows.getBinaryStream(column)) {
                            if (stream == null) {
                                cell.update((byte) 0);
                            } else {
                                cell.update((byte) 1);
                                int length;
                                while ((length = stream.read(buffer)) != -1) {
                                    cell.update(buffer, 0, length);
                                }
                            }
                        }
                        digest.update(cell.digest());
                    }
                }
            }
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    static List<String> primaryKeys(Connection connection, String table) throws SQLException, IOException {
        Map<Integer, String> primary = new java.util.TreeMap<>();
        try (Statement statement = connection.createStatement(); ResultSet info = statement.executeQuery("PRAGMA table_info(" + quote(table) + ")")) {
            while (info.next()) {
                if (info.getInt("pk") > 0) {
                    primary.put(info.getInt("pk"), quote(info.getString("name")));
                }
            }
        }
        if (primary.isEmpty()) {
            throw new IOException("DATABASE_IDENTITY_UNSUPPORTED");
        }
        return List.copyOf(primary.values());
    }

    static JsonObject metrics(Connection connection) throws SQLException {
        JsonObject metrics = new JsonObject();
        metrics.addProperty("pageCount", scalar(connection, "PRAGMA page_count"));
        metrics.addProperty("pageSize", scalar(connection, "PRAGMA page_size"));
        metrics.addProperty("freelistCount", scalar(connection, "PRAGMA freelist_count"));
        JsonObject counts = new JsonObject();
        for (String table : tables(connection)) {
            counts.addProperty(table, scalar(connection, "SELECT count(*) FROM " + quote(table)));
        }
        metrics.add("rowCounts", counts);
        return metrics;
    }

    public static int remove(Connection connection, String table, String column, String id) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("DELETE FROM " + quote(table) + " WHERE " + quote(column) + "=?")) {
            statement.setString(1, id);
            return statement.executeUpdate();
        }
    }

    public static String quote(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    static MessageDigest digest() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static JsonObject loadSchemas() {
        try (InputStream stream = CodexStorageDatabase.class.getResourceAsStream("/codex-storage-schemas.json")) {
            if (stream == null) {
                throw new IOException("Schema registry missing");
            }
            return JsonParser.parseString(new String(stream.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
        } catch (IOException error) {
            throw new ExceptionInInitializerError(error);
        }
    }
}
