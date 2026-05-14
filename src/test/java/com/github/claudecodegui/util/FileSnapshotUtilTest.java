package com.github.claudecodegui.util;

import org.junit.Assume;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class FileSnapshotUtilTest {

    @Test
    public void captureDirectorySnapshotSkipsSymlinkedFiles() throws Exception {
        Path root = Files.createTempDirectory("cc-gui-snapshot-root");
        Path outside = Files.createTempDirectory("cc-gui-snapshot-outside");
        try {
            Path source = root.resolve("source.txt");
            Path secret = outside.resolve("secret.txt");
            Path link = root.resolve("secret-link.txt");
            Files.writeString(source, "safe");
            Files.writeString(secret, "secret");
            try {
                Files.createSymbolicLink(link, secret);
            } catch (UnsupportedOperationException | SecurityException e) {
                Assume.assumeNoException(e);
            }

            var snapshots = FileSnapshotUtil.captureDirectorySnapshot(root);

            assertTrue(snapshots.containsKey(source.toRealPath().toString()));
            assertFalse(snapshots.containsKey(link.toAbsolutePath().normalize().toString()));
            assertFalse(snapshots.containsKey(secret.toRealPath().toString()));
        } finally {
            Files.deleteIfExists(root.resolve("secret-link.txt"));
            Files.deleteIfExists(root.resolve("source.txt"));
            Files.deleteIfExists(outside.resolve("secret.txt"));
            Files.deleteIfExists(root);
            Files.deleteIfExists(outside);
        }
    }
}
