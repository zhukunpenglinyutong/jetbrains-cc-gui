package com.github.claudecodegui.handler.file;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for @ file search matching.
 * Guards against absolute-path over-matching and missing fuzzy subsequence match.
 */
public class FileListRequestMatchTest {

    @Test
    public void emptyQueryMatchesEverything() {
        FileHandler.FileListRequest request = new FileHandler.FileListRequest("", "");
        assertTrue(request.matches("Dockerfile", "Dockerfile"));
        assertTrue(request.matches("anything", "/abs/path"));
    }

    @Test
    public void substringMatchesFileName() {
        FileHandler.FileListRequest request = new FileHandler.FileListRequest("build", "");
        assertTrue(request.matches("build.gradle", "build.gradle"));
        assertFalse(request.matches("Dockerfile", "Dockerfile"));
    }

    @Test
    public void doesNotMatchAbsolutePathContainingQueryLetter() {
        // Project folder "jetbrains-cc-gui" contains "b"; absolute path must not count
        FileHandler.FileListRequest request = new FileHandler.FileListRequest("b", "");
        assertFalse(request.matches(
                "Dockerfile",
                "/Users/zhukunpeng/Desktop/CC GUI 项目/jetbrains-cc-gui/Dockerfile"
        ));
        assertFalse(request.matches(
                "skills-lock.json",
                "/Users/me/jetbrains-cc-gui/skills-lock.json"
        ));
        assertFalse(request.matches(
                "SlashCommandRegistry.java",
                "C:\\Users\\me\\jetbrains-cc-gui\\src\\SlashCommandRegistry.java"
        ));
    }

    @Test
    public void matchesRelativePathSubstring() {
        FileHandler.FileListRequest request = new FileHandler.FileListRequest("handler", "");
        assertTrue(request.matches(
                "FileHandler.java",
                "src/main/java/com/github/claudecodegui/handler/file/FileHandler.java"
        ));
    }

    @Test
    public void fuzzySubsequenceMatchesCamelCaseStyleQueries() {
        FileHandler.FileListRequest request = new FileHandler.FileListRequest("scr", "");
        assertTrue(request.matches("SlashCommandRegistry.java", "src/SlashCommandRegistry.java"));

        FileHandler.FileListRequest bg = new FileHandler.FileListRequest("bg", "");
        assertTrue(bg.matches("build.gradle", "build.gradle"));
    }

    @Test
    public void ranksNamePrefixAboveNameContains() {
        FileHandler.FileListRequest request = new FileHandler.FileListRequest("b", "");
        int buildScore = request.score("build.gradle", "build.gradle");
        int contributingScore = request.score("CONTRIBUTING.md", "CONTRIBUTING.md");
        int dockerScore = request.score("Dockerfile", "Dockerfile");

        assertTrue(buildScore > contributingScore);
        assertEquals(0, dockerScore);
    }

    @Test
    public void fuzzySubsequenceHelper() {
        assertTrue(FileHandler.FileListRequest.fuzzySubsequenceMatch("build.gradle", "bg"));
        assertFalse(FileHandler.FileListRequest.fuzzySubsequenceMatch("dockerfile", "xyz"));
        assertTrue(FileHandler.FileListRequest.fuzzySubsequenceMatch("anything", ""));
    }
}
