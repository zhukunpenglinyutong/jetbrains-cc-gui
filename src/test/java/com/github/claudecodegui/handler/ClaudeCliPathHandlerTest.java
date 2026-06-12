package com.github.claudecodegui.handler;

import org.junit.Assume;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit-tests the pure path-validation branches of
 * {@link ClaudeCliPathHandler#validateCliPath(File, String)}.
 *
 * <p>The handler's persistence path depends on
 * {@link com.intellij.ide.util.PropertiesComponent} (an IntelliJ service), so the
 * validation logic was extracted into a static method that can be exercised with plain
 * {@link File} fixtures — no platform boot required. These tests guard the security/UX
 * invariant that a non-existent, directory, or non-executable path is rejected before the
 * handler persists anything or restarts the daemon.
 */
public class ClaudeCliPathHandlerTest {

    @Test
    public void validateRejectsNonExistentFile() {
        File missing = new File(System.getProperty("java.io.tmpdir"), "cc-gui-claude-cli-missing-zzz");
        String reason = ClaudeCliPathHandler.validateCliPath(missing, missing.getPath());
        assertNotNull("A non-existent path must be rejected", reason);
        assertTrue("Reason should explain the file is missing: " + reason,
                reason.startsWith("File does not exist"));
    }

    @Test
    public void validateRejectsDirectory() throws IOException {
        File dir = Files.createTempDirectory("cc-gui-claude-cli-dir").toFile();
        dir.deleteOnExit();
        String reason = ClaudeCliPathHandler.validateCliPath(dir, dir.getPath());
        assertNotNull("A directory must be rejected", reason);
        assertTrue("Reason should explain the path is a directory: " + reason,
                reason.startsWith("Path is a directory"));
    }

    @Test
    public void validateRejectsNonExecutableFile() throws IOException {
        File file = Files.createTempFile("cc-gui-claude-cli-noexec", ".bin").toFile();
        file.deleteOnExit();
        file.setExecutable(false, false);
        // Some filesystems / privileged users cannot represent a non-executable regular
        // file (canExecute stays true); skip rather than fail spuriously in that case.
        Assume.assumeFalse("Filesystem cannot strip the execute bit", file.canExecute());

        String reason = ClaudeCliPathHandler.validateCliPath(file, file.getPath());
        assertNotNull("A non-executable file must be rejected", reason);
        assertTrue("Reason should explain the file is not executable: " + reason,
                reason.startsWith("File is not executable"));
    }

    @Test
    public void validateAcceptsExecutableFile() throws IOException {
        File file = Files.createTempFile("cc-gui-claude-cli-ok", ".sh").toFile();
        file.deleteOnExit();
        assertTrue("Test precondition: set the execute bit", file.setExecutable(true, false));

        String reason = ClaudeCliPathHandler.validateCliPath(file, file.getPath());
        assertNull("A usable executable file must pass validation, got: " + reason, reason);
    }
}
