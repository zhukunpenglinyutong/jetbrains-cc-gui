package com.github.claudecodegui.handler;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.*;

/**
 * Tests for {@link RollbackHandler} utility methods.
 *
 * Validates CWD sanitisation, JSONL path construction with security checks,
 * and path traversal prevention.
 */
public class RollbackHandlerTest {

    // ── sanitizeCwd ──────────────────────────────────────────────────────

    @Test
    public void sanitizeCwdNullReturnsEmpty() {
        assertEquals("", RollbackHandler.sanitizeCwd(null));
    }

    @Test
    public void sanitizeCwdEmptyReturnsEmpty() {
        assertEquals("", RollbackHandler.sanitizeCwd(""));
    }

    @Test
    public void sanitizeCwdNormalPath() {
        String result = RollbackHandler.sanitizeCwd("/home/user/project");
        assertFalse(result.isEmpty());
        assertFalse(result.contains("/"));
        assertFalse(result.contains("\\"));
    }

    @Test
    public void sanitizeCwdWindowsPath() {
        String result = RollbackHandler.sanitizeCwd("C:\\Users\\me\\project");
        assertFalse(result.contains("\\"));
        assertFalse(result.contains(":"));
        // Should contain parts of the path separated by hyphens
        assertTrue(result.contains("C") || result.contains("Users"));
    }

    @Test
    public void sanitizeCwdTruncatesLongPaths() {
        String longPath = "a-" + "verylongsegment".repeat(10);
        String result = RollbackHandler.sanitizeCwd(longPath);
        assertTrue(result.length() <= 64);
    }

    // ── buildJsonlPath ───────────────────────────────────────────────────

    @Test
    public void buildJsonlPathValidSessionId() {
        String path = RollbackHandler.buildJsonlPath("/home/user/proj", "abc-123-def").toString();
        assertTrue(path.endsWith("abc-123-def.jsonl"));
        // Should contain the projects directory component
        assertTrue(path.replace("\\", "/").contains(".claude/projects/"));
    }

    @Test
    public void buildJsonlPathWithNullSessionIdThrows() {
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", null));
    }

    @Test
    public void buildJsonlPathWithEmptySessionIdThrows() {
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", ""));
    }

    @Test
    public void buildJsonlPathWithInvalidSessionIdThrows() {
        // sessionId containing path traversal chars should be rejected
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", "../evil"));
    }

    @Test
    public void buildJsonlPathWithSlashInSessionIdThrows() {
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", "a/b"));
    }

    @Test
    public void buildJsonlPathWithDotDotInSessionIdThrows() {
        // Malicious sessionId attempting path escape
        assertThrows(IllegalArgumentException.class,
            () -> RollbackHandler.buildJsonlPath("/tmp", "..\\..\\etc"));
    }

    @Test
    public void buildJsonlPathResolvesWithinProjectsDir() {
        // Even if cwd contains traversal, sanitizeCwd replaces special chars
        // so the resolved path stays within the projects directory.
        String path = RollbackHandler.buildJsonlPath("../../evil", "valid-uuid").toString();
        // The sanitized cwd should not contain ".." — sanitizeCwd replaces
        // non-alphanumeric chars (including '.') with hyphens.
        assertFalse(path.contains(".."));
    }

    @Test
    public void buildJsonlPathHandlesNonExistentCwd() {
        // A non-existent directory name should still produce a valid-looking path
        String path = RollbackHandler.buildJsonlPath("/nonexistent/path", "valid-uuid-123").toString();
        assertTrue(path.replace("\\", "/").contains("/nonexistent/path".replace("/", "-")));
    }

    // ── findUserMessageIndex ─────────────────────────────────────────────

    private static ClaudeSession.Message userMessage(String content, String uuid, String localId) {
        ClaudeSession.Message message = new ClaudeSession.Message(ClaudeSession.Message.Type.USER, content);
        if (uuid != null) {
            JsonObject raw = new JsonObject();
            raw.addProperty("uuid", uuid);
            message.raw = raw;
        }
        if (localId != null) {
            message.localId = localId;
        }
        return message;
    }

    @Test
    public void findUserMessageIndexPrefersUuidOverLocalIdAndText() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(userMessage("first", "uuid-1", "local-1"));
        messages.add(userMessage("second", "uuid-2", "local-2"));

        // Every identifier resolves to a different message; the uuid must win.
        assertEquals(0, RollbackHandler.findUserMessageIndex(messages, "uuid-1", "local-2", "second"));
    }

    @Test
    public void findUserMessageIndexFallsBackToLocalIdWhenUuidMissing() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(userMessage("first", null, "local-1"));
        messages.add(userMessage("second", null, "local-2"));

        assertEquals(0, RollbackHandler.findUserMessageIndex(messages, null, "local-1", null));
    }

    @Test
    public void findUserMessageIndexFallsBackToTextWhenNoIdentifierMatches() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(userMessage("first", null, "local-1"));
        messages.add(userMessage("second", null, "local-2"));

        assertEquals(1, RollbackHandler.findUserMessageIndex(messages, "unknown", "unknown", "second"));
    }

    @Test
    public void findUserMessageIndexMatchesTextAcrossFormattingDifferences() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(userMessage("explain this\r\n\r\n\r\n", null, null));

        // Same text as the stored content, only line endings and blank-line padding
        // differ — the shape a uuid back-fill has to survive.
        assertEquals(0, RollbackHandler.findUserMessageIndex(messages, null, null, "explain this"));
    }

    @Test
    public void findUserMessageIndexIgnoresToolResultPlaceholders() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(userMessage("[tool_result]", null, null));

        assertEquals(-1, RollbackHandler.findUserMessageIndex(messages, null, null, "[tool_result]"));
    }

    @Test
    public void findUserMessageIndexIgnoresAssistantMessages() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "same text"));

        assertEquals(-1, RollbackHandler.findUserMessageIndex(messages, null, null, "same text"));
    }

    @Test
    public void findUserMessageIndexReturnsLastMatchForDuplicateText() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(userMessage("same", null, null));
        messages.add(userMessage("same", null, null));

        assertEquals(1, RollbackHandler.findUserMessageIndex(messages, null, null, "same"));
    }

    @Test
    public void findUserMessageIndexReturnsMinusOneWhenUnresolved() {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(userMessage("first", null, null));

        assertEquals(-1, RollbackHandler.findUserMessageIndex(messages, "nope", "nope", "different"));
    }

    // ── findJsonlTargetLine ──────────────────────────────────────────────

    private static final Gson GSON = new Gson();

    private static String userLine(String uuid, String text) {
        return "{\"type\":\"user\",\"uuid\":\"" + uuid + "\","
                + "\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"" + text + "\"}]}}";
    }

    @Test
    public void findJsonlTargetLineMatchesUuid() {
        List<String> lines = Arrays.asList(
            userLine("uuid-1", "first"),
            userLine("uuid-2", "second"));

        assertEquals(1, RollbackHandler.findJsonlTargetLine(lines, GSON, "uuid-2", null));
    }

    @Test
    public void findJsonlTargetLineFallsBackToUserText() {
        List<String> lines = Arrays.asList(
            "{\"type\":\"attachment\",\"uuid\":\"a-1\"}",
            userLine("uuid-1", "first"),
            userLine("uuid-2", "second"));

        assertEquals(2, RollbackHandler.findJsonlTargetLine(lines, GSON, null, "second"));
    }

    @Test
    public void findJsonlTargetLineMatchesNormalizedUserText() {
        List<String> lines = Arrays.asList(userLine("uuid-1", "explain this"));

        // Stored content carries trailing blank lines the CLI record does not.
        assertEquals(0, RollbackHandler.findJsonlTargetLine(lines, GSON, null, "explain this\n\n\n"));
    }

    @Test
    public void findJsonlTargetLineSkipsToolResultRecords() {
        List<String> lines = Arrays.asList(
            "{\"type\":\"user\",\"uuid\":\"uuid-1\",\"message\":{\"content\":"
                + "[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"output\"}]}}");

        assertEquals(-1, RollbackHandler.findJsonlTargetLine(lines, GSON, null, "output"));
    }

    @Test
    public void findJsonlTargetLineReturnsMinusOneWhenMessageNotPersisted() {
        List<String> lines = Arrays.asList(userLine("uuid-1", "first"));

        assertEquals(-1, RollbackHandler.findJsonlTargetLine(lines, GSON, "uuid-2", "second"));
    }

    @Test
    public void findJsonlTargetLineToleratesMalformedLines() {
        List<String> lines = Arrays.asList("not json", userLine("uuid-1", "first"));

        assertEquals(1, RollbackHandler.findJsonlTargetLine(lines, GSON, null, "first"));
    }
}
