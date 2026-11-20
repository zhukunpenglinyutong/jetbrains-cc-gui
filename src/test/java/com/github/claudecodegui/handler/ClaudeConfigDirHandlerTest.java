package com.github.claudecodegui.handler;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
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

    @Test
    public void wslLinuxPathIsValidatedThroughItsUncForm() throws Exception {
        File profile = tmp.newFolder("unc-profile");
        String error = ClaudeConfigDirHandler.validateInput("/home/me/p", tmp.getRoot().getPath(), true,
                linux -> profile.getPath(), linux -> false);
        assertNull(error);
    }

    @Test
    public void wslLinuxPathFallsBackToAWslDirectoryCheckWhenTheShareSaysMissing() {
        String missing = tmp.getRoot().toPath().resolve("share-lag").toString();
        String error = ClaudeConfigDirHandler.validateInput("/home/me/p", tmp.getRoot().getPath(), true,
                linux -> missing, linux -> linux.equals("/home/me/p"));
        assertNull(error);
    }

    @Test
    public void wslLinuxPathThatExistsNowhereIsRejected() {
        String missing = tmp.getRoot().toPath().resolve("nowhere").toString();
        String error = ClaudeConfigDirHandler.validateInput("/home/me/p", tmp.getRoot().getPath(), true,
                linux -> missing, linux -> false);
        assertNotNull(error);
        assertTrue(error.contains("does not exist"));
    }

    @Test
    public void unreachableWslIsReportedInsteadOfAcceptingTheValue() {
        String error = ClaudeConfigDirHandler.validateInput("/home/me/p", tmp.getRoot().getPath(), true,
                linux -> null, linux -> true);
        assertNotNull(error);
        assertTrue(error.contains("WSL"));
    }

    @Test
    public void nativeNodeNeverTakesTheWslFallback() throws Exception {
        String error = ClaudeConfigDirHandler.validateInput(tmp.getRoot().toPath().resolve("absent").toString(),
                tmp.getRoot().getPath(), false, null, linux -> true);
        assertNotNull(error);
        assertTrue(error.contains("does not exist"));
    }

    @Test
    public void savedMessageNamesTheDirectory() {
        assertEquals("Claude config directory saved: /p", ClaudeConfigDirHandler.savedMessage("/p", false));
    }

    @Test
    public void clearedMessageNamesNoDirectory() {
        assertEquals("Claude config directory cleared", ClaudeConfigDirHandler.savedMessage("", false));
    }

    /** Clearing returns to ~/.claude, whose settings.json can hold API settings of its own as well. */
    @Test
    public void clearedMessageExplainsAProviderThatWasNotApplied() {
        String message = ClaudeConfigDirHandler.savedMessage("", true);
        assertTrue(message.startsWith("Claude config directory cleared"));
        assertTrue(message.contains("own API settings"));
    }

    @Test
    public void savedMessageExplainsAProviderThatWasNotApplied() {
        String message = ClaudeConfigDirHandler.savedMessage("/p", true);
        assertTrue(message.startsWith("Claude config directory saved: /p"));
        assertTrue(message.contains("own API settings"));
        assertTrue(message.contains("Local settings.json"));
        assertTrue(message.contains("select the provider again"));
    }

    @Test
    public void relativeInputIsRejectedByValidateInput() {
        String error = ClaudeConfigDirHandler.validateInput("profile", tmp.getRoot().getPath(), false, null, linux -> true);
        assertNotNull(error);
        assertTrue(error.contains("absolute"));
    }
}
