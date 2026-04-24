package com.github.claudecodegui.provider.common;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SessionLiteReaderTest {

    private final SessionLiteReader reader = new SessionLiteReader();

    @Test
    public void extractJsonStringField_firstMatch() {
        String text = "{\"type\":\"user\",\"message\":\"hello world\",\"timestamp\":\"2026-01-01T00:00:00Z\"}";
        assertEquals("user", reader.extractJsonStringField(text, "type"));
        assertEquals("hello world", reader.extractJsonStringField(text, "message"));
        assertEquals("2026-01-01T00:00:00Z", reader.extractJsonStringField(text, "timestamp"));
    }

    @Test
    public void extractJsonStringField_withSpaces() {
        String text = "{\"type\": \"user\", \"message\": \"hello world\"}";
        assertEquals("user", reader.extractJsonStringField(text, "type"));
        assertEquals("hello world", reader.extractJsonStringField(text, "message"));
    }

    @Test
    public void extractJsonStringField_notFound() {
        String text = "{\"type\":\"user\"}";
        assertNull(reader.extractJsonStringField(text, "nonexistent"));
    }

    @Test
    public void extractJsonStringField_nullInput() {
        assertNull(reader.extractJsonStringField(null, "type"));
        assertNull(reader.extractJsonStringField("text", null));
    }

    @Test
    public void extractJsonStringField_escapedValue() {
        String text = "{\"message\":\"hello \\\"world\\\"\"}";
        assertEquals("hello \"world\"", reader.extractJsonStringField(text, "message"));
    }

    @Test
    public void extractJsonStringField_emptyValue() {
        String text = "{\"message\":\"\"}";
        assertEquals("", reader.extractJsonStringField(text, "message"));
    }

    @Test
    public void extractLastJsonStringField_returnsLastOccurrence() {
        String text = "{\"customTitle\":\"first\",\"customTitle\":\"last\"}";
        assertEquals("last", reader.extractLastJsonStringField(text, "customTitle"));
    }

    @Test
    public void extractLastJsonStringField_singleOccurrence() {
        String text = "{\"customTitle\":\"only one\"}";
        assertEquals("only one", reader.extractLastJsonStringField(text, "customTitle"));
    }

    @Test
    public void extractLastJsonStringField_notFound() {
        String text = "{\"type\":\"user\"}";
        assertNull(reader.extractLastJsonStringField(text, "customTitle"));
    }

    @Test
    public void isSidechainSession_true() {
        String head = "{\"isSidechain\":true,\"type\":\"user\"}\nmore content";
        assertTrue(reader.isSidechainSession(head));
    }

    @Test
    public void isSidechainSession_trueWithSpace() {
        String head = "{\"isSidechain\": true,\"type\":\"user\"}\nmore content";
        assertTrue(reader.isSidechainSession(head));
    }

    @Test
    public void isSidechainSession_false() {
        String head = "{\"type\":\"user\",\"message\":\"hello\"}\nmore content";
        assertFalse(reader.isSidechainSession(head));
    }

    @Test
    public void isSidechainSession_empty() {
        assertFalse(reader.isSidechainSession(""));
        assertFalse(reader.isSidechainSession(null));
    }

    @Test
    public void extractFirstPromptFromHead_simplePrompt() {
        // Lite-read now supports array content format via JSON parsing fallback
        String head = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"What is Java?\"}]}}\n";
        String result = reader.extractFirstPromptFromHead(head);
        // Array content is now extracted correctly
        assertEquals("What is Java?", result);
    }

    @Test
    public void extractFirstPromptFromHead_stringContent() {
        String head = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Hello world\"},\"timestamp\":\"2026-01-01T00:00:00Z\"}\n";
        String result = reader.extractFirstPromptFromHead(head);
        assertEquals("Hello world", result);
    }

    @Test
    public void extractFirstPromptFromHead_skipsToolResult() {
        String head = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"tool_result\",\"tool_result\":true}}\n";
        assertNull(reader.extractFirstPromptFromHead(head));
    }

    @Test
    public void extractFirstPromptFromHead_skipsMeta() {
        String head = "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"meta message\"}}\n";
        assertNull(reader.extractFirstPromptFromHead(head));
    }

    @Test
    public void extractFirstPromptFromHead_truncatesLongContent() {
        String longContent = "a".repeat(300);
        String head = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"" + longContent + "\"}}\n";
        String result = reader.extractFirstPromptFromHead(head);
        assertNotNull(result);
        assertTrue(result.length() <= 201); // 200 chars + ellipsis
        assertTrue(result.endsWith("\u2026"));
    }

    @Test
    public void readSessionLite_smallFile() throws IOException {
        Path tempFile = Files.createTempFile("test-session", ".jsonl");
        try {
            String content = "{\"type\":\"user\",\"content\":\"hello\"}\n{\"type\":\"assistant\",\"content\":\"hi\"}\n";
            Files.writeString(tempFile, content);

            SessionLiteReader.LiteSessionFile lite = reader.readSessionLite(tempFile);
            assertNotNull(lite);
            assertTrue(lite.size > 0);
            // For small files, head should contain all content
            assertTrue(lite.head.contains("hello"));
            // For small files, head and tail are the same
            assertEquals(lite.head, lite.tail);
        } finally {
            Files.deleteIfExists(tempFile);
        }
    }

    @Test
    public void readSessionLite_emptyFile() throws IOException {
        Path tempFile = Files.createTempFile("test-empty", ".jsonl");
        try {
            Files.writeString(tempFile, "");
            assertNull(reader.readSessionLite(tempFile));
        } finally {
            Files.deleteIfExists(tempFile);
        }
    }

    @Test
    public void countMessagesInHead() {
        String head = "{\"type\":\"user\",\"content\":\"hello\"}\n{\"type\":\"assistant\",\"content\":\"hi\"}\n\n{\"type\":\"user\",\"content\":\"bye\"}\n";
        assertEquals(3, reader.countMessagesInHead(head));
    }

    @Test
    public void countMessagesInHead_skipsSidechain() {
        String head = "{\"type\":\"user\",\"content\":\"hello\"}\n{\"isSidechain\":true,\"type\":\"assistant\"}\n";
        assertEquals(1, reader.countMessagesInHead(head));
    }

    @Test
    public void countMessagesInHead_empty() {
        assertEquals(0, reader.countMessagesInHead(null));
        assertEquals(0, reader.countMessagesInHead(""));
    }
}