package com.github.claudecodegui.handler;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Path;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClaudeConfigDirHandlerTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void existingDirectoryIsAccepted() throws Exception {
        File dir = tmp.newFolder("profile");
        assertNull(ClaudeConfigDirHandler.validateConfigDir(dir.toPath(), dir.getPath()));
    }

    @Test
    public void missingDirectoryIsRejected() {
        Path missing = tmp.getRoot().toPath().resolve("nope");
        String error = ClaudeConfigDirHandler.validateConfigDir(missing, "nope");
        assertNotNull(error);
        assertTrue(error.contains("does not exist"));
    }

    @Test
    public void regularFileIsRejected() throws Exception {
        File file = tmp.newFile("settings.json");
        String error = ClaudeConfigDirHandler.validateConfigDir(file.toPath(), file.getPath());
        assertNotNull(error);
        assertTrue(error.contains("not a directory"));
    }

    @Test
    public void relativePathIsRejectedEvenWhenItExists() throws Exception {
        tmp.newFolder("profile");
        String error = ClaudeConfigDirHandler.validateConfigDir(java.nio.file.Paths.get("profile"), "profile");
        assertNotNull(error);
        assertTrue(error.contains("absolute"));
    }

    @Test
    public void tildeExpandedAgainstHomeIsAccepted() throws Exception {
        File home = tmp.newFolder("home");
        File profile = new File(home, ".claude-work");
        assertTrue(profile.mkdir());
        Path expanded = com.github.claudecodegui.util.ClaudeConfigDir.expand("~/.claude-work", home.getPath());
        assertNull(ClaudeConfigDirHandler.validateConfigDir(expanded, "~/.claude-work"));
    }

    @Test
    public void bareTildeProfileThatDoesNotExistIsRejected() throws Exception {
        File home = tmp.newFolder("home2");
        Path expanded = com.github.claudecodegui.util.ClaudeConfigDir.expand("~/.missing", home.getPath());
        String error = ClaudeConfigDirHandler.validateConfigDir(expanded, "~/.missing");
        assertNotNull(error);
        assertTrue(error.contains("does not exist"));
    }
}
