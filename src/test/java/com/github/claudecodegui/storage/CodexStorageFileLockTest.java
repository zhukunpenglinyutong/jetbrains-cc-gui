package com.github.claudecodegui.storage;

import com.sun.jna.Platform;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

public class CodexStorageFileLockTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void competingHandlesBlockAndClosingReleasesTheNativeLock() throws Exception {
        var paths = new CodexStoragePaths(temporary.newFolder().toPath());
        var file = paths.root().resolve("test.lock");
        try (var first = CodexStorageFileLock.tryAcquire(paths, file, true)) {
            assertNotNull(first);
            if (Platform.isLinux() || Platform.isMac()) {
                assertEquals(java.util.Set.of(java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                        java.nio.file.attribute.PosixFilePermission.OWNER_WRITE), Files.getPosixFilePermissions(file));
            }
            assertNull(CodexStorageFileLock.tryAcquire(paths, file, false));
        }
        try (var next = CodexStorageFileLock.tryAcquire(paths, file, false)) {
            assertNotNull(next);
            next.close();
            next.close();
            try (var afterRepeatedClose = CodexStorageFileLock.tryAcquire(paths, file, false)) {
                assertNotNull(afterRepeatedClose);
            }
        }
    }

    @Test public void posixFlockInteroperatesWithAnIndependentNativeProcessInBothDirections() throws Exception {
        assumeTrue(Platform.isLinux() || Platform.isMac());
        var paths = new CodexStoragePaths(temporary.newFolder().toPath());
        var file = paths.root().resolve("native-锁.lock");
        Files.createFile(file);
        String hold = "import fcntl,sys; f=open(sys.argv[1], 'r+'); fcntl.flock(f, fcntl.LOCK_EX); print('LOCKED', flush=True); sys.stdin.read()";
        Process owner = new ProcessBuilder("python3", "-c", hold, file.toString()).redirectErrorStream(true).start();
        try {
            var ready = java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                try {
                    return new BufferedReader(new InputStreamReader(owner.getInputStream())).readLine();
                } catch (java.io.IOException error) {
                    throw new java.io.UncheckedIOException(error);
                }
            });
            assertEquals("LOCKED", ready.get(10, TimeUnit.SECONDS));
            assertNull(CodexStorageFileLock.tryAcquire(paths, file, false));
        } finally {
            owner.destroyForcibly();
            assertTrue(owner.waitFor(10, TimeUnit.SECONDS));
        }
        try (var lock = CodexStorageFileLock.tryAcquire(paths, file, false)) {
            assertNotNull(lock);
            String probe = "import fcntl,sys; f=open(sys.argv[1], 'r+');\ntry: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)\n";
            Process contender = new ProcessBuilder("python3", "-c", probe, file.toString()).redirectErrorStream(true).start();
            try {
                assertTrue(contender.waitFor(10, TimeUnit.SECONDS));
                assertEquals(73, contender.exitValue());
            } finally {
                contender.destroyForcibly();
            }
        }
    }
}
