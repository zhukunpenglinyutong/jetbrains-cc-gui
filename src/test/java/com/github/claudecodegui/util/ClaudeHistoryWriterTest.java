package com.github.claudecodegui.util;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for {@link ClaudeHistoryWriter}.
 */
public class ClaudeHistoryWriterTest {

    private static final Gson GSON = new Gson();
    private Path tempDir;

    @Before
    public void setUp() throws IOException {
        tempDir = Files.createTempDirectory("claude-history-writer-test");
    }

    @After
    public void tearDown() throws IOException {
        // Clean up temp files
        Files.walk(tempDir)
                .sorted((a, b) -> b.compareTo(a)) // Reverse order for directories
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException ignored) {
                    }
                });
    }

    @Test
    public void appendAssistantMessage_withExistingSession_appendsParentedAssistantLine() throws Exception {
        String projectPath = tempDir.resolve("test-project").toString();
        String sessionId = "11111111-1111-1111-1111-111111111111";
        Path projectDir = tempDir.resolve(PathUtils.sanitizePath(projectPath));
        Files.createDirectories(projectDir);
        Path sessionFile = projectDir.resolve(sessionId + ".jsonl");
        Files.writeString(sessionFile,
                "{\"type\":\"user\",\"uuid\":\"parent-uuid\",\"timestamp\":\"2026-01-01T00:00:00Z\","
                        + "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
                StandardCharsets.UTF_8);

        boolean appended = ClaudeHistoryWriter.appendAssistantMessage(
                projectPath,
                sessionId,
                "Test message",
                tempDir
        );

        assertTrue(appended);
        List<String> lines = Files.readAllLines(sessionFile, StandardCharsets.UTF_8);
        assertEquals(2, lines.size());

        JsonObject appendedLine = JsonParser.parseString(lines.get(1)).getAsJsonObject();
        assertEquals("assistant", appendedLine.get("type").getAsString());
        assertEquals("parent-uuid", appendedLine.get("parentUuid").getAsString());
        assertEquals(sessionId, appendedLine.get("sessionId").getAsString());

        JsonObject message = appendedLine.getAsJsonObject("message");
        assertEquals("assistant", message.get("role").getAsString());
        JsonArray content = message.getAsJsonArray("content");
        assertEquals("text", content.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("Test message", content.get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void appendAssistantMessage_missingSessionFileDoesNotCreateHistory() throws Exception {
        String projectPath = tempDir.resolve("test-project").toString();
        String sessionId = "22222222-2222-2222-2222-222222222222";
        Path sessionFile = tempDir.resolve(PathUtils.sanitizePath(projectPath)).resolve(sessionId + ".jsonl");

        boolean appended = ClaudeHistoryWriter.appendAssistantMessage(
                projectPath,
                sessionId,
                "Test message",
                tempDir
        );

        assertFalse(appended);
        assertFalse(Files.exists(sessionFile));
    }

    @Test
    public void appendAssistantMessage_withNullProjectPath_doesNotThrow() {
        ClaudeHistoryWriter.appendAssistantMessage(null, "session-123", "Test");
        // Should not throw
    }

    @Test
    public void appendAssistantMessage_withBlankSessionId_doesNotThrow() {
        ClaudeHistoryWriter.appendAssistantMessage("/some/path", "", "Test");
        // Should not throw
    }

    @Test
    public void appendAssistantMessage_withNullContent_doesNotThrow() {
        ClaudeHistoryWriter.appendAssistantMessage("/some/path", "session-123", null);
        // Should not throw
    }

    @Test
    public void appendAssistantMessage_withBlankContent_doesNotThrow() {
        ClaudeHistoryWriter.appendAssistantMessage("/some/path", "session-123", "   ");
        // Should not throw
    }

    @Test
    public void appendAssistantMessage_withI18nPlaceholder_doesNotThrow() {
        ClaudeHistoryWriter.appendAssistantMessage("/some/path", "session-123", "__I18N__:chat.requestInterrupted");
        // Should not throw
    }

    @Test
    public void sanitizePath_handlesNullAndEmpty() {
        assertEquals("", PathUtils.sanitizePath(null));
        assertEquals("", PathUtils.sanitizePath(""));
        // Non-alphanumeric characters are replaced with -
        String result = PathUtils.sanitizePath("D:\\Projects\\MyProject");
        assertNotNull(result);
        assertFalse(result.isEmpty());
    }
}
