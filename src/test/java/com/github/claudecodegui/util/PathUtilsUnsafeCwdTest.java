package com.github.claudecodegui.util;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class PathUtilsUnsafeCwdTest {

    @Test
    public void rejectsJetBrainsPluginTree() {
        assertTrue(PathUtils.isUnsafeWorkingDirectory(
                "/Users/x/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/idea-claude-code-gui/ai-bridge"));
    }

    @Test
    public void rejectsGeminiHome() {
        assertTrue(PathUtils.isUnsafeWorkingDirectory("/Users/x/.gemini"));
        assertTrue(PathUtils.isUnsafeWorkingDirectory("/Users/x/.gemini/antigravity-cli"));
    }

    @Test
    public void rejectsAiBridgePath() {
        assertTrue(PathUtils.isUnsafeWorkingDirectory("/path/to/plugin/ai-bridge"));
    }

    @Test
    public void acceptsNormalProject() {
        assertFalse(PathUtils.isUnsafeWorkingDirectory("/path/to/normal/project"));
        assertFalse(PathUtils.isUnsafeWorkingDirectory("/Users/x/projects/my-app"));
    }

    @Test
    public void guardFallsBackToProjectBase() throws Exception {
        Path project = Files.createTempDirectory("ccg-cwd-project-");
        try {
            String unsafe = project.resolve("ai-bridge").toString();
            Files.createDirectories(Path.of(unsafe));
            String guarded = PathUtils.selectSafeWorkingDirectory(unsafe, project.toString());
            assertEquals(project.toRealPath().toString(), Path.of(guarded).toRealPath().toString());
        } finally {
            deleteRecursively(project);
        }
    }

    @Test
    public void guardKeepsSafeRequested() throws Exception {
        Path project = Files.createTempDirectory("ccg-cwd-ok-");
        try {
            String guarded = PathUtils.selectSafeWorkingDirectory(project.toString(), project.toString());
            assertEquals(project.toRealPath().toString(), Path.of(guarded).toRealPath().toString());
        } finally {
            deleteRecursively(project);
        }
    }

    @Test
    public void guardReturnsNullWhenNothingSafe() {
        assertNull(PathUtils.selectSafeWorkingDirectory(
                "/Users/x/.gemini",
                "/Users/x/Library/Application Support/JetBrains/IntelliJIdea2026.2/plugins/idea-claude-code-gui"));
    }

    private static void deleteRecursively(Path root) throws Exception {
        if (root == null || !Files.exists(root)) {
            return;
        }
        try (var walk = Files.walk(root)) {
            walk.sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        }
    }
}
