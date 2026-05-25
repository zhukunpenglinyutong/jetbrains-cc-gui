package com.github.claudecodegui.provider.claude;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClaudeHistoryParserTest {

    @Test
    public void scanSingleSession_treatsDeletedFileAsRecoverableScanMiss() {
        AtomicReference<Exception> reportedFailure = new AtomicReference<>();
        ClaudeHistoryParser parser = new ClaudeHistoryParser((path, error) -> reportedFailure.set(error));

        ClaudeHistoryReader.SessionInfo info = parser.scanSingleSession(
                Path.of("/tmp/missing-session-aaaaaaaa-1111-4111-8111-111111111111.jsonl")
        );

        assertNull(info);
        assertTrue(reportedFailure.get() instanceof NoSuchFileException);
    }

    @Test
    public void scanSingleSession_extractsEarliestAndLatestTimestamps() throws IOException {
        Path sessionFile = Files.createTempFile("claude-history-parser", ".jsonl");
        try {
            Files.write(sessionFile, List.of(
                    "{\"type\":\"assistant\",\"timestamp\":\"2026-03-10T10:10:00Z\",\"message\":{\"content\":\"Reply\"}}",
                    "{\"type\":\"user\",\"timestamp\":\"2026-03-10T10:00:00Z\",\"message\":{\"content\":\"Hello\"}}"
            ));

            ClaudeHistoryParser parser = new ClaudeHistoryParser();
            ClaudeHistoryReader.SessionInfo session = parser.scanSingleSession(sessionFile);

            assertNotNull(session);
            assertEquals(Instant.parse("2026-03-10T10:00:00Z").toEpochMilli(), session.firstTimestamp);
            assertEquals(Instant.parse("2026-03-10T10:10:00Z").toEpochMilli(), session.lastTimestamp);
            assertNotEquals(session.firstTimestamp, session.lastTimestamp);
        } finally {
            Files.deleteIfExists(sessionFile);
        }
    }
}
