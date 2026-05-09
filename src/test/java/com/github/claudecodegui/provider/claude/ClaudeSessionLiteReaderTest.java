package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.SessionLiteReader;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClaudeSessionLiteReaderTest {

    private final ClaudeSessionLiteReader reader = new ClaudeSessionLiteReader();

    @Test
    public void readSessionLite_claudeSession() throws IOException {
        Path tempDir = Files.createTempDirectory("claude-lite-test");
        try {
            Path tempFile = tempDir.resolve("abc12345-1234-1234-1234-1234567890ab.jsonl");
            String content = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Hello Claude\"},\"timestamp\":\"2026-01-15T10:00:00Z\",\"sessionId\":\"abc12345-1234-1234-1234-1234567890ab\"}\n" +
                    "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"Hi there!\"},\"timestamp\":\"2026-01-15T10:01:00Z\"}\n" +
                    "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"How are you?\"},\"timestamp\":\"2026-01-15T10:02:00Z\"}\n";
            Files.writeString(tempFile, content);

            ClaudeSessionLiteReader.ClaudeLiteSessionInfo info = reader.readSessionLite(tempFile);
            assertNotNull(info);
            assertEquals("abc12345-1234-1234-1234-1234567890ab", info.sessionId);
            assertNotNull(info.summary);
            assertTrue(info.messageCount >= 1);
            assertTrue(info.createdAt > 0);
        } finally {
            Files.walk(tempDir).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (IOException ignored) {}
            });
        }
    }

    @Test
    public void readSessionLite_skipsSidechain() throws IOException {
        Path tempDir = Files.createTempDirectory("claude-lite-test");
        try {
            Path tempFile = tempDir.resolve("abc12345-1234-1234-1234-1234567890ab.jsonl");
            String content = "{\"isSidechain\":true,\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"side\"}}\n";
            Files.writeString(tempFile, content);

            assertNull(reader.readSessionLite(tempFile));
        } finally {
            Files.walk(tempDir).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (IOException ignored) {}
            });
        }
    }

    @Test
    public void parseSessionInfoFromLite_extractsTitle() {
        String sessionId = "abc12345-1234-1234-1234-1234567890ab";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"user\",\"content\":\"What is Java?\",\"timestamp\":\"2026-01-15T10:00:00Z\"}\n",
                "{\"customTitle\":\"My Session Title\"}\n"
        );

        ClaudeSessionLiteReader.ClaudeLiteSessionInfo info = reader.parseSessionInfoFromLite(sessionId, lite);
        assertNotNull(info);
        assertEquals("My Session Title", info.summary);
        assertEquals("My Session Title", info.customTitle);
    }

    @Test
    public void parseSessionInfoFromLite_noTitleReturnsNull() {
        String sessionId = "abc12345-1234-1234-1234-1234567890ab";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"system\",\"content\":\"init\"}\n",
                ""
        );

        assertNull(reader.parseSessionInfoFromLite(sessionId, lite));
    }

    @Test
    public void parseSessionInfoFromLite_skipsAgentSession() {
        String sessionId = "agent-12345678";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"user\",\"content\":\"hello\"}\n",
                ""
        );

        assertNull(reader.parseSessionInfoFromLite(sessionId, lite));
    }

    @Test
    public void parseSessionInfoFromLite_skipsWarmup() {
        String sessionId = "abc12345-1234-1234-1234-1234567890ab";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"user\",\"content\":\"warmup\"}\n",
                ""
        );

        assertNull(reader.parseSessionInfoFromLite(sessionId, lite));
    }
}