package com.github.claudecodegui.handler;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/**
 * Unit tests for the DSH connection settings validators
 * ({@link DshHostHandler#validateDshHost} / {@link DshHostHandler#validateDshBin}).
 */
public class DshHostHandlerTest {

    // ---------- validateDshHost ----------

    @Test
    public void validateDshHost_acceptsHostnamesAndIps() {
        assertNull(DshHostHandler.validateDshHost("localhost"));
        assertNull(DshHostHandler.validateDshHost("127.0.0.1"));
        assertNull(DshHostHandler.validateDshHost("dsh.internal.example.com"));
    }

    @Test
    public void validateDshHost_acceptsEmptyAsClearOverride() {
        assertNull(DshHostHandler.validateDshHost(null));
        assertNull(DshHostHandler.validateDshHost(""));
    }

    @Test
    public void validateDshHost_rejectsScheme() {
        assertNotNull(DshHostHandler.validateDshHost("http://127.0.0.1"));
        assertNotNull(DshHostHandler.validateDshHost("https://dsh.example.com"));
    }

    @Test
    public void validateDshHost_rejectsEmbeddedPort() {
        assertNotNull(DshHostHandler.validateDshHost("127.0.0.1:3080"));
        assertNotNull(DshHostHandler.validateDshHost("localhost:8080"));
    }

    @Test
    public void validateDshHost_rejectsWhitespace() {
        assertNotNull(DshHostHandler.validateDshHost("local host"));
        assertNotNull(DshHostHandler.validateDshHost("host\tname"));
        assertNotNull(DshHostHandler.validateDshHost("host\nname"));
    }

    @Test
    public void validateDshHost_rejectsPathSeparators() {
        assertNotNull(DshHostHandler.validateDshHost("foo/bar"));
        assertNotNull(DshHostHandler.validateDshHost("foo\\bar"));
    }

    // ---------- validateDshBin ----------

    @Test
    public void validateDshBin_acceptsEmptyAsClearOverride() {
        assertNull(DshHostHandler.validateDshBin(null));
        assertNull(DshHostHandler.validateDshBin(""));
    }

    @Test
    public void validateDshBin_acceptsNonExistentPath() {
        // Not-yet-installed binaries are allowed: the path is validated when used.
        assertNull(DshHostHandler.validateDshBin("/definitely/not/installed/dsh-" + System.nanoTime()));
    }

    @Test
    public void validateDshBin_acceptsExistingRegularFile() throws Exception {
        Path file = Files.createTempFile("dsh-bin", ".sh");
        try {
            assertNull(DshHostHandler.validateDshBin(file.toString()));
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    public void validateDshBin_rejectsExistingDirectory() throws Exception {
        Path dir = Files.createTempDirectory("dsh-bin-dir");
        try {
            assertNotNull(DshHostHandler.validateDshBin(dir.toString()));
        } finally {
            Files.deleteIfExists(dir);
        }
    }

    @Test
    public void validateDshBin_rejectsControlCharacters() {
        assertNotNull(DshHostHandler.validateDshBin("/usr/bin/dsh\nrm -rf /"));
        assertNotNull(DshHostHandler.validateDshBin("/usr/bin/dsh\r"));
        assertNotNull(DshHostHandler.validateDshBin("/usr/bin/dsh\t"));
    }
}
