package com.github.claudecodegui.storage;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.sqlite.JDBC;
import org.sqlite.SQLiteJDBCLoader;

import java.net.URI;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

import static org.junit.Assert.*;

/** Fresh JVMs exercise native initialization independently of the other storage fixtures. */
public class CodexSqliteNativeLibraryTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void leavesOtherLoadersLibrariesUntouchedInTheSystemTempDirectory() throws Exception {
        runPeer("default");
    }

    @Test public void restoresAnExplicitSqliteTempDirectoryAfterIsolatedInitialization() throws Exception {
        runPeer("configured");
    }

    @Test public void failedInitializationRestoresThePropertyAndCanBeRetried() throws Exception {
        runPeer("retry");
    }

    @Test public void concurrentPluginLoadersRestoreTheSharedProperty() throws Exception {
        runPeer("concurrent");
    }

    private void runPeer(String mode) throws Exception {
        Path root = temporary.newFolder(mode).toPath();
        Path classes = Files.createDirectory(root.resolve("classes"));
        for (Class<?> type : List.of(NativePeer.class, CodexStorageDatabase.class, CodexSqliteNativeLibrary.class)) {
            String resource = type.getName().replace('.', '/') + ".class";
            copyResource(classes, resource);
        }
        copyResource(classes, "codex-storage-schemas.json");
        Path sqlite = jarFor(JDBC.class);
        String classPath = String.join(java.io.File.pathSeparator, classes.toString(), sqlite.toString(), jarFor(JsonObject.class).toString());
        Path output = root.resolve("peer-output.txt");
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", classPath, NativePeer.class.getName(), mode, root.toString(), sqlite.toString())
                .redirectErrorStream(true).redirectOutput(output.toFile()).start();
        try {
            assertTrue("Native initialization peer timed out", process.waitFor(25, TimeUnit.SECONDS));
            String diagnostic = Files.readString(output);
            assertEquals(diagnostic, 0, process.exitValue());
            assertFalse(diagnostic, diagnostic.contains("Failed to delete old native lib"));
            assertTrue(diagnostic, diagnostic.contains("ISOLATED_NATIVE_OK"));
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
    }

    private static Path jarFor(Class<?> type) throws Exception {
        URL resource = Objects.requireNonNull(type.getResource("/" + type.getName().replace('.', '/') + ".class"));
        String location = resource.toExternalForm();
        int separator = location.indexOf("!/");
        assertTrue(location, location.startsWith("jar:") && separator > 4);
        // IntelliJ uses a URLConnection implementation that is not a JarURLConnection.
        return Path.of(URI.create(location.substring(4, separator)));
    }

    private static void copyResource(Path classes, String resource) throws Exception {
        Path target = classes.resolve(resource);
        Files.createDirectories(target.getParent());
        try (var input = Objects.requireNonNull(CodexSqliteNativeLibraryTest.class.getResourceAsStream("/" + resource))) {
            Files.copy(input, target);
        }
    }

    public static class NativePeer {
        public static void main(String[] args) throws Exception {
            Path root = Path.of(args[1]);
            Path shared = Files.createDirectory(root.resolve("shared-temp"));
            Path database = Files.createFile(root.resolve("fixture.sqlite"));
            System.setProperty("java.io.tmpdir", shared.toString());
            System.clearProperty("org.sqlite.tmpdir");
            if ("concurrent".equals(args[0])) {
                checkConcurrentLoaders(database, shared);
            } else if ("retry".equals(args[0])) {
                System.setProperty("org.sqlite.tmpdir", database.toString());
                try {
                    CodexStorageDatabase.open(database, true).close();
                    throw new AssertionError("Expected an extraction-directory failure");
                } catch (SQLException expected) {
                    check("SQLITE_NATIVE_INITIALIZATION_FAILED".equals(expected.getMessage()), "Wrong failure classification");
                    check(database.toString().equals(System.getProperty("org.sqlite.tmpdir")), "Failed initialization changed the property");
                }
                System.setProperty("org.sqlite.tmpdir", shared.toString());
                openAndCheck(database);
                check(shared.toString().equals(System.getProperty("org.sqlite.tmpdir")), "Retry changed the property");
            } else {
                if ("configured".equals(args[0])) {
                    System.setProperty("org.sqlite.tmpdir", shared.toString());
                }
                String previous = System.getProperty("org.sqlite.tmpdir");
                // A different plugin loader owns this DLL. Simulate its missing cleanup marker.
                try (var other = new URLClassLoader(new URL[] {Path.of(args[2]).toUri().toURL()}, ClassLoader.getPlatformClassLoader())) {
                    Class.forName("org.sqlite.SQLiteJDBCLoader", true, other).getMethod("initialize").invoke(null);
                    List<Path> libraries;
                    try (var files = Files.list(shared)) {
                        libraries = files.filter(path -> path.getFileName().toString().startsWith("sqlite-")
                                && !path.toString().endsWith(".lck")).toList();
                    }
                    check(!libraries.isEmpty(), "Other loader did not extract its native library");
                    for (Path library : libraries) {
                        Files.deleteIfExists(Path.of(library + ".lck"));
                    }
                    Path marker = Files.writeString(shared.resolve("sqlite-" + SQLiteJDBCLoader.getVersion() + "-foreign-marker"), "untouched");
                    openAndCheck(database);
                    openAndCheck(database);
                    check(Files.exists(marker), "Driver cleanup touched the shared directory");
                    if (System.getProperty("os.name").startsWith("Windows")) {
                        for (Path library : libraries) {
                            check(Files.exists(library), "Another loader's DLL was removed");
                        }
                    }
                    check(Objects.equals(previous, System.getProperty("org.sqlite.tmpdir")), "Initialization changed the property");
                    try (var files = Files.list(shared)) {
                        check(files.filter(path -> path.getFileName().toString().startsWith("ccgui-sqlite-")).count() == 1,
                                "Connections should share one isolated extraction directory per loader");
                    }
                }
            }
            check(shared.toString().equals(System.getProperty("java.io.tmpdir")), "Global JVM temp directory changed");
            System.out.println("ISOLATED_NATIVE_OK");
        }

        private static void checkConcurrentLoaders(Path database, Path shared) throws Exception {
            URL[] urls = Arrays.stream(System.getProperty("java.class.path").split(java.io.File.pathSeparator))
                    .map(path -> Path.of(path).toUri()).map(uri -> {
                        try { return uri.toURL(); } catch (Exception error) { throw new IllegalStateException(error); }
                    }).toArray(URL[]::new);
            var executor = Executors.newFixedThreadPool(2);
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            try (var first = new URLClassLoader(urls, ClassLoader.getPlatformClassLoader());
                 var second = new URLClassLoader(urls, ClassLoader.getPlatformClassLoader())) {
                var pending = List.of(first, second).stream().map(loader -> executor.submit(() -> {
                    Class<?> type = Class.forName("com.github.claudecodegui.storage.CodexStorageDatabase", true, loader);
                    ready.countDown();
                    check(start.await(10, TimeUnit.SECONDS), "Concurrent start timed out");
                    try (var connection = (java.sql.Connection) type.getMethod("open", Path.class, boolean.class).invoke(null, database, true);
                         var statement = connection.createStatement(); var rows = statement.executeQuery("SELECT 1")) {
                        check(rows.next() && rows.getInt(1) == 1, "Concurrent native query failed");
                    }
                    return true;
                })).toList();
                check(ready.await(10, TimeUnit.SECONDS), "Concurrent loaders were not ready");
                start.countDown();
                for (var result : pending) {
                    check(result.get(15, TimeUnit.SECONDS), "Concurrent load failed");
                }
                check(System.getProperty("org.sqlite.tmpdir") == null, "Concurrent loaders leaked the shared property");
                try (var files = Files.list(shared)) {
                    check(files.filter(path -> path.getFileName().toString().startsWith("ccgui-sqlite-")).count() == 2,
                            "Each concurrent loader must own a separate extraction directory");
                }
            } finally {
                start.countDown();
                executor.shutdownNow();
            }
        }

        private static void openAndCheck(Path database) throws Exception {
            try (var connection = CodexStorageDatabase.open(database, true);
                 var statement = connection.createStatement(); var rows = statement.executeQuery("SELECT sqlite_version()")) {
                check(rows.next() && !rows.getString(1).isBlank(), "Native database query failed");
                statement.execute("PRAGMA query_only");
                try (var mode = statement.getResultSet()) {
                    check(mode.next() && mode.getInt(1) == 1, "Read-only connection lost query_only");
                }
            }
        }

        private static void check(boolean condition, String message) {
            if (!condition) {
                throw new AssertionError(message);
            }
        }
    }
}
