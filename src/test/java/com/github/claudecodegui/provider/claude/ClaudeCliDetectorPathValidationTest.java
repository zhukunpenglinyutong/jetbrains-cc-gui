package com.github.claudecodegui.provider.claude;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression guard for PR #1191 review item H2: the user-facing settings UI used
 * to feed arbitrary strings into {@link ClaudeCliDetector#setCliPath(String)},
 * which would then execute that path as a child process during verification. The
 * fix is a name + executability allow-list — these tests pin its behavior.
 */
public class ClaudeCliDetectorPathValidationTest {

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void rejectsRelativePaths() {
        assertFalse(ClaudeCliDetector.isValidCliPath("./claude"));
        assertFalse(ClaudeCliDetector.isValidCliPath("../claude"));
        assertFalse(ClaudeCliDetector.isValidCliPath("claude"));
    }

    @Test
    public void rejectsNullOrBlank() {
        assertFalse(ClaudeCliDetector.isValidCliPath(null));
        assertFalse(ClaudeCliDetector.isValidCliPath(""));
        assertFalse(ClaudeCliDetector.isValidCliPath("   "));
    }

    @Test
    public void rejectsNonExistingFile() {
        File bogus = new File(folder.getRoot(), "does-not-exist-claude");
        assertFalse(ClaudeCliDetector.isValidCliPath(bogus.getAbsolutePath()));
    }

    @Test
    public void rejectsDirectories() throws IOException {
        File dir = folder.newFolder("claude");
        assertFalse(ClaudeCliDetector.isValidCliPath(dir.getAbsolutePath()));
    }

    @Test
    public void rejectsNonClaudeBinaryName() throws IOException {
        File evil = folder.newFile("rm");
        if (!evil.setExecutable(true)) {
            // Skip if we cannot mark executable on this platform.
            return;
        }
        assertFalse("must not allow arbitrary binaries to be set as CLI path",
                ClaudeCliDetector.isValidCliPath(evil.getAbsolutePath()));
    }

    @Test
    public void rejectsShellWithClaudeNameSuffix() throws IOException {
        File sneaky = folder.newFile("nclaude");
        if (!sneaky.setExecutable(true)) {
            return;
        }
        assertFalse("must require the file name to actually start with 'claude'",
                ClaudeCliDetector.isValidCliPath(sneaky.getAbsolutePath()));
    }

    @Test
    public void acceptsPlainClaudeBinary() throws IOException {
        File claude = folder.newFile("claude");
        if (!claude.setExecutable(true)) {
            return;
        }
        assertTrue(ClaudeCliDetector.isValidCliPath(claude.getAbsolutePath()));
    }

    @Test
    public void acceptsClaudeCmdAndExe() throws IOException {
        File cmd = folder.newFile("claude.cmd");
        File exe = folder.newFile("claude.exe");
        // On non-Windows these need exec bit; on Windows isValidCliPath skips that check.
        cmd.setExecutable(true);
        exe.setExecutable(true);
        assertTrue(ClaudeCliDetector.isValidCliPath(cmd.getAbsolutePath()));
        assertTrue(ClaudeCliDetector.isValidCliPath(exe.getAbsolutePath()));
    }
}
