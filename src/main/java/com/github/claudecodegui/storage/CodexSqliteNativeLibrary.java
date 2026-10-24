package com.github.claudecodegui.storage;

import org.sqlite.SQLiteJDBCLoader;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;

/** Keeps Xerial's startup cleanup away from libraries owned by other IDEs or plugin loaders. */
final class CodexSqliteNativeLibrary {
    private static final String TEMP_DIRECTORY_PROPERTY = "org.sqlite.tmpdir";
    // Dynamic plugin reloads use different class monitors but share JVM properties.
    private static final Object INITIALIZATION_LOCK = "com.github.claudecodegui.sqlite-native-initialization".intern();
    private static boolean initialized;

    private CodexSqliteNativeLibrary() { }

    static synchronized void initialize() throws SQLException {
        if (initialized) {
            return;
        }
        synchronized (INITIALIZATION_LOCK) {
            initializeDriver();
            initialized = true;
        }
    }

    private static void initializeDriver() throws SQLException {
        // The driver also synchronizes on this class when initializing through a JDBC connection.
        synchronized (SQLiteJDBCLoader.class) {
            String previousDirectory = System.getProperty(TEMP_DIRECTORY_PROPERTY);
            Path directory = null;
            try {
                Path base = Path.of(previousDirectory != null ? previousDirectory : System.getProperty("java.io.tmpdir"));
                directory = Files.createTempDirectory(base, "ccgui-sqlite-");
                // Register the directory first so the driver's own file cleanup runs before it.
                directory.toFile().deleteOnExit();
                System.setProperty(TEMP_DIRECTORY_PROPERTY, directory.toString());
                if (!SQLiteJDBCLoader.initialize()) {
                    throw new SQLException("SQLITE_NATIVE_INITIALIZATION_FAILED");
                }
            } catch (Exception error) {
                throw new SQLException("SQLITE_NATIVE_INITIALIZATION_FAILED", error);
            } finally {
                // Do not persist an IDE-wide setting or overwrite a concurrent explicit change.
                if (directory != null && directory.toString().equals(System.getProperty(TEMP_DIRECTORY_PROPERTY))) {
                    if (previousDirectory == null) {
                        System.clearProperty(TEMP_DIRECTORY_PROPERTY);
                    } else {
                        System.setProperty(TEMP_DIRECTORY_PROPERTY, previousDirectory);
                    }
                }
            }
        }
    }
}
