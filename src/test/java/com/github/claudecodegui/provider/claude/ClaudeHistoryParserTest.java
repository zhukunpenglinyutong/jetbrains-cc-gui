package com.github.claudecodegui.provider.claude;

import org.junit.Test;

import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicReference;

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
}
