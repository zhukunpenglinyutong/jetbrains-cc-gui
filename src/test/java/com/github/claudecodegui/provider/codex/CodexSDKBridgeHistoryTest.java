package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.MessageParser;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

public class CodexSDKBridgeHistoryTest {

    @Test
    public void getSessionMessagesReadsPersistedCodexHistory() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-history");
        try {
            writeSessionFile(
                    sessionsDir,
                    "session-restore",
                    line("2026-03-10T10:00:00Z", "event_msg",
                            "{\"type\":\"user_message\",\"message\":\"Restore Codex tab\"}"),
                    line("2026-03-10T10:01:00Z", "response_item",
                            "{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Restored from Codex history\"}]}" )
            );

            CodexSDKBridge bridge = new CodexSDKBridge(sessionsDir);

            List<JsonObject> messages = bridge.getSessionMessages("session-restore", sessionsDir.toString());

            assertEquals(2, messages.size());
            assertEquals("user", messages.get(0).get("type").getAsString());
            assertEquals("Restore Codex tab", messages.get(0).get("content").getAsString());
            assertEquals("assistant", messages.get(1).get("type").getAsString());
            assertEquals("Restored from Codex history", messages.get(1).get("content").getAsString());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void getSessionMessagesPreservesToolResultForAutoRestore() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-history-tool-result");
        try {
            writeSessionFile(
                    sessionsDir,
                    "session-tool-result",
                    line("2026-03-10T10:00:00Z", "response_item",
                            "{\"type\":\"function_call_output\",\"call_id\":\"call-1\",\"output\":\"command output\"}")
            );

            CodexSDKBridge bridge = new CodexSDKBridge(sessionsDir);
            List<JsonObject> messages = bridge.getSessionMessages("session-tool-result", sessionsDir.toString());

            assertEquals(1, messages.size());
            assertEquals("user", messages.get(0).get("type").getAsString());
            assertEquals("[tool_result]", messages.get(0).get("content").getAsString());
            assertEquals("tool_result", messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("call-1", messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject().get("tool_use_id").getAsString());
            assertEquals("command output", messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject().get("content").getAsString());

            ClaudeSession.Message restored = new MessageParser().parseServerMessage(messages.get(0));
            assertNotNull(restored);
            assertEquals(ClaudeSession.Message.Type.USER, restored.type);
            assertEquals("[tool_result]", restored.content);
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void getSessionMessagesMatchesHistoryPanelForCustomToolCalls() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-history-custom-tool");
        try {
            writeSessionFile(
                    sessionsDir,
                    "session-custom-tool",
                    line("2026-03-10T10:00:00Z", "response_item",
                            "{\"type\":\"custom_tool_call\",\"call_id\":\"custom-1\",\"name\":\"apply_patch\",\"input\":\"*** Update File: src/Main.java\\n-old\\n+new\"}")
            );

            CodexSDKBridge bridge = new CodexSDKBridge(sessionsDir);
            List<JsonObject> messages = bridge.getSessionMessages("session-custom-tool", sessionsDir.toString());

            assertEquals(1, messages.size());
            assertEquals("assistant", messages.get(0).get("type").getAsString());
            assertEquals("tool_use", messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
            assertEquals("apply_patch", messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject().get("name").getAsString());
            assertEquals("src/Main.java", messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject().getAsJsonObject("input").get("file_path").getAsString());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void getSessionMessagesNormalizesToolNamesLikeHistoryPanelPath() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-history-tool-name");
        try {
            writeSessionFile(
                    sessionsDir,
                    "session-tool-name",
                    line("2026-03-10T10:00:00Z", "response_item",
                            "{\"type\":\"function_call\",\"call_id\":\"call-2\",\"name\":\"shell_command\",\"arguments\":\"{\\\"command\\\":\\\"cat README.md\\\"}\"}")
            );

            CodexSDKBridge bridge = new CodexSDKBridge(sessionsDir);
            List<JsonObject> messages = bridge.getSessionMessages("session-tool-name", sessionsDir.toString());

            assertEquals(1, messages.size());
            assertEquals("assistant", messages.get(0).get("type").getAsString());
            assertEquals("read", messages.get(0).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject().get("name").getAsString());
            assertEquals("Tool: read", messages.get(0).get("content").getAsString());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    private static Path writeSessionFile(Path dir, String sessionId, String... lines) throws IOException {
        Files.createDirectories(dir);
        Path file = dir.resolve(sessionId + ".jsonl");
        Files.write(file, String.join("\n", lines).concat("\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        return file;
    }

    private static String line(String timestamp, String type, String payloadJson) {
        return "{\"timestamp\":\"" + timestamp + "\",\"type\":\"" + type + "\",\"payload\":" + payloadJson + "}";
    }

    private static void deleteDirectory(Path path) throws IOException {
        if (!Files.exists(path)) {
            return;
        }
        try (java.util.stream.Stream<Path> paths = Files.walk(path)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                }
            });
        }
    }
}
