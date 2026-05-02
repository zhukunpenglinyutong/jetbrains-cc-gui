package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.SessionLiteReader;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CodexSessionLiteReaderTest {

    private final CodexSessionLiteReader reader = new CodexSessionLiteReader();

    @Test
    public void readSessionLite_codexSession() throws IOException {
        Path tempDir = Files.createTempDirectory("codex-lite-test");
        try {
            Path tempFile = tempDir.resolve("thread_abc123def456.jsonl");
            String content = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread_abc123def456\",\"cwd\":\"/workspace/demo\",\"timestamp\":\"2026-03-10T10:00:00Z\"}}\n" +
                    "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Hello Codex\"},\"timestamp\":\"2026-03-10T10:01:00Z\"}\n" +
                    "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"},\"timestamp\":\"2026-03-10T10:02:00Z\"}\n";
            Files.writeString(tempFile, content);

            CodexSessionLiteReader.CodexLiteSessionInfo info = reader.readSessionLite(tempFile);
            assertNotNull(info);
            assertEquals("thread_abc123def456", info.sessionId);
            assertNotNull(info.summary);
            assertTrue(info.messageCount >= 1);
            assertEquals("/workspace/demo", info.cwd);
        } finally {
            Files.walk(tempDir).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (IOException ignored) {}
            });
        }
    }

    @Test
    public void parseSessionInfoFromLite_extractsTitle() {
        String sessionId = "thread_abc123def456";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread_abc123def456\",\"cwd\":\"/workspace\",\"timestamp\":\"2026-03-10T10:00:00Z\"}}\n" +
                        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"What is Python?\"}}\n",
                ""
        );

        CodexSessionLiteReader.CodexLiteSessionInfo info = reader.parseSessionInfoFromLite(sessionId, lite);
        assertNotNull(info);
        assertEquals("thread_abc123def456", info.sessionId);
        assertNotNull(info.summary);
        assertTrue(info.summary.contains("Python"));
        assertEquals("/workspace", info.cwd);
    }

    @Test
    public void parseSessionInfoFromLite_skipsLowSignalLatestUserMessage() {
        String sessionId = "thread_abc123def456";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"请帮我修复历史标题\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"请帮我修复历史标题\"}}\n" +
                        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"继续\"}}\n"
        );

        CodexSessionLiteReader.CodexLiteSessionInfo info = reader.parseSessionInfoFromLite(sessionId, lite);
        assertNotNull(info);
        assertEquals("请帮我修复历史标题", info.summary);
    }

    @Test
    public void parseSessionInfoFromLite_noTitleReturnsNull() {
        String sessionId = "thread_abc123def456";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"thread_abc123def456\"}}\n" +
                        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"}}\n",
                ""
        );

        assertNull(reader.parseSessionInfoFromLite(sessionId, lite));
    }

    @Test
    public void parseSessionInfoFromLite_stripsSystemTags() {
        String sessionId = "thread_abc123def456";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"<agents-instructions>some content</agents-instructions>Real question here\"}}\n",
                ""
        );

        CodexSessionLiteReader.CodexLiteSessionInfo info = reader.parseSessionInfoFromLite(sessionId, lite);
        assertNotNull(info);
        assertTrue(info.summary.contains("Real question here"));
        assertTrue(!info.summary.contains("agents-instructions"));
    }

    @Test
    public void parseSessionInfoFromLite_stripsAgentRoleSectionMarker() {
        String sessionId = "thread_abc123def456";
        SessionLiteReader.LiteSessionFile lite = new SessionLiteReader.LiteSessionFile(
                System.currentTimeMillis(), 1000,
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"How to run this project?\\n\\n## Agent Role and Instructions\\n\\ninternal text\"}}\n",
                ""
        );

        CodexSessionLiteReader.CodexLiteSessionInfo info = reader.parseSessionInfoFromLite(sessionId, lite);
        assertNotNull(info);
        assertTrue(info.summary.contains("How to run this project?"));
        assertTrue(!info.summary.contains("Agent Role and Instructions"));
    }

    @Test
    public void readSessionLite_invalidSessionId() throws IOException {
        Path tempDir = Files.createTempDirectory("codex-lite-test");
        try {
            Path tempFile = tempDir.resolve("invalid-name.jsonl");
            Files.writeString(tempFile, "{\"type\":\"session_meta\"}\n");
            assertNull(reader.readSessionLite(tempFile));
        } finally {
            Files.walk(tempDir).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (IOException ignored) {}
            });
        }
    }

    @Test
    public void readSessionLite_usesExactResponseItemCountForLargeFile() throws IOException {
        Path tempDir = Files.createTempDirectory("codex-lite-count-test");
        try {
            String sessionId = "thread_abc123def456";
            Path tempFile = tempDir.resolve(sessionId + ".jsonl");

            StringBuilder sb = new StringBuilder();
            sb.append("{\"type\":\"session_meta\",\"payload\":{\"id\":\"")
                    .append(sessionId)
                    .append("\",\"cwd\":\"/workspace/demo\",\"timestamp\":\"2026-03-10T10:00:00Z\"}}\n");
            sb.append("{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Count test\"},\"timestamp\":\"2026-03-10T10:01:00Z\"}\n");
            int responseItems = 5000;
            for (int i = 0; i < responseItems; i++) {
                sb.append("{\"type\":\"response_item\",\"payload\":{\"type\":\"message\"},\"timestamp\":\"2026-03-10T10:02:00Z\"}\n");
            }
            Files.writeString(tempFile, sb.toString(), StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);

            CodexSessionLiteReader.CodexLiteSessionInfo info = reader.readSessionLite(tempFile);
            assertNotNull(info);
            assertEquals(responseItems, info.messageCount);
        } finally {
            Files.walk(tempDir).sorted((a, b) -> b.compareTo(a)).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (IOException ignored) {}
            });
        }
    }
}
