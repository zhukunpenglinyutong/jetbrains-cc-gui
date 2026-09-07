package com.github.claudecodegui.provider.minimax;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class MiniMaxHistoryReaderTest {
    private Path tempRoot;
    private Path sessionDir;

    @Before
    public void setUp() throws IOException {
        tempRoot = Files.createTempDirectory("minimax-history-test");
        sessionDir = tempRoot.resolve("v2").resolve("sessions").resolve("2026").resolve("08").resolve("25").resolve("test-session-dir");
        Files.createDirectories(sessionDir);
    }

    @After
    public void tearDown() throws IOException {
        if (tempRoot != null && Files.exists(tempRoot)) {
            deleteRecursively(tempRoot);
        }
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        if (Files.isDirectory(root)) {
            try (java.nio.file.DirectoryStream<Path> stream = Files.newDirectoryStream(root)) {
                for (Path child : stream) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(root);
    }

    @Test
    public void mapsLastAssistantUsageIntoGeneratedMessages() throws Exception {
        String sessionId = "test-session-123";
        String snapshot = "{"
                + "\"record\":{"
                + "\"sessionId\":\"" + sessionId + "\","
                + "\"workspaceDir\":\"E:/test/project\","
                + "\"title\":\"test\","
                + "\"createdAtMs\":1,"
                + "\"updatedAtMs\":2"
                + "},"
                + "\"displayMessages\":["
                + "{\"role\":\"user\",\"msg_content\":\"hello user\"},"
                + "{\"role\":\"assistant\",\"msg_content\":\"first assistant\"},"
                + "{\"role\":\"assistant\",\"msg_content\":\"second assistant\","
                + "\"usage\":{\"total_tokens\":30248,\"context_window\":400000,\"input_tokens\":23993,\"output_tokens\":493,\"cache_read\":5762}}"
                + "]}";
        Files.writeString(sessionDir.resolve("snapshot.json"), snapshot, StandardCharsets.UTF_8);

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(tempRoot, new Gson());
        List<JsonObject> messages = reader.getSessionMessages(sessionId, "E:/test/project");

        assertEquals(3, messages.size());
        assertEquals("user", messages.get(0).get("type").getAsString());

        // First assistant has no usage.
        JsonObject firstAssistant = messages.get(1);
        assertEquals("assistant", firstAssistant.get("type").getAsString());
        assertFalse(firstAssistant.has("usage"));

        // Second assistant carries mapped usage.
        JsonObject secondAssistant = messages.get(2);
        assertEquals("assistant", secondAssistant.get("type").getAsString());
        assertTrue(secondAssistant.has("usage"));
        JsonObject usage = secondAssistant.getAsJsonObject("usage");
        assertEquals(23993, usage.get("input_tokens").getAsInt());
        assertEquals(5762, usage.get("cache_read_input_tokens").getAsInt());
        assertEquals(400000, usage.get("model_context_window").getAsInt());
        assertFalse(usage.has("cache_read"));
        assertFalse(usage.has("context_window"));
    }
}
