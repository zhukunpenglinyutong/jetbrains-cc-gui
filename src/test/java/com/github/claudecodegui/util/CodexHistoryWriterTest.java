package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CodexHistoryWriterTest {

    @Test
    public void appendProviderErrorWritesProviderErrorLineToMatchingSessionFile() throws IOException {
        Path sessionsDir = Files.createTempDirectory("codex-history-writer");
        try {
            Path sessionFile = sessionsDir
                    .resolve("2026")
                    .resolve("06")
                    .resolve("09")
                    .resolve("rollout-2026-06-09T08-00-00-thread-1.jsonl");
            Files.createDirectories(sessionFile.getParent());
            Files.writeString(sessionFile,
                    "{\"timestamp\":\"2026-06-09T08:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"thread-1\"}}\n",
                    StandardCharsets.UTF_8);

            boolean appended = CodexHistoryWriter.appendProviderError(
                    "thread-1",
                    "服务暂时不可用",
                    "Codex CLI 请求失败，原因：服务暂时不可用 (503)",
                    1,
                    sessionsDir);

            assertTrue(appended);
            List<String> lines = Files.readAllLines(sessionFile, StandardCharsets.UTF_8);
            assertEquals(2, lines.size());

            JsonObject line = JsonParser.parseString(lines.get(1)).getAsJsonObject();
            assertEquals("provider_error", line.get("type").getAsString());
            JsonObject payload = line.getAsJsonObject("payload");
            assertEquals("codex", payload.get("provider").getAsString());
            assertEquals("服务暂时不可用", payload.get("summary").getAsString());
            assertEquals("Codex CLI 请求失败，原因：服务暂时不可用 (503)",
                    payload.get("details").getAsString());
            assertEquals(1, payload.get("exitCode").getAsInt());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    private void deleteDirectory(Path dir) throws IOException {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
    }
}
