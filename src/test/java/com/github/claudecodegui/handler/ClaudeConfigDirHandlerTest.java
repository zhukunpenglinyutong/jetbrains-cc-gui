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
}
