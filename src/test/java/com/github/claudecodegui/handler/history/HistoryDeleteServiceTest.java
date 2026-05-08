package com.github.claudecodegui.handler.history;

import org.junit.Test;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class HistoryDeleteServiceTest {

    @Test
    public void parseSessionIdsAcceptsArrayPayload() {
        assertEquals(
                Arrays.asList("session-one", "session-two"),
                HistoryDeleteService.parseSessionIds("[\"session-one\",\"session-two\"]"));
    }

    @Test
    public void parseSessionIdsAcceptsObjectPayload() {
        assertEquals(
                Arrays.asList("session-one", "session-two"),
                HistoryDeleteService.parseSessionIds("{\"sessionIds\":[\"session-one\",\"session-two\"]}"));
    }

    @Test
    public void parseSessionIdsTrimsAndDeduplicates() {
        assertEquals(
                Arrays.asList("session-one", "session-two"),
                HistoryDeleteService.parseSessionIds("[\" session-one \",\"session-two\",\"session-one\",\"\"]"));
    }

    @Test
    public void parseSessionIdsRejectsMissingPayload() {
        assertEquals(Collections.emptyList(), HistoryDeleteService.parseSessionIds(""));
        assertEquals(Collections.emptyList(), HistoryDeleteService.parseSessionIds(null));
    }

    @Test
    public void parseSessionIdsRejectsMalformedPayload() {
        assertEquals(Collections.emptyList(), HistoryDeleteService.parseSessionIds("["));
    }

    @Test
    public void codexFileMatchAnchorsToHyphenAndExtension() {
        String sessionId = "019b690b-c87f-7350-8f45-bc3dbb59ff77";
        Path matching = Paths.get("/tmp/rollout-2025-12-29T15-38-58-" + sessionId + ".jsonl");
        assertTrue(HistoryDeleteService.isCodexSessionFileMatch(matching, sessionId));
    }

    @Test
    public void codexFileMatchRejectsSubstringWithinNeighbouringSessionId() {
        // Different session whose UUID merely contains the target as a substring
        String target = "abcd1234";
        Path neighbour = Paths.get("/tmp/rollout-2025-12-29T15-38-58-prefix" + target + "suffix.jsonl");
        assertFalse(HistoryDeleteService.isCodexSessionFileMatch(neighbour, target));
    }

    @Test
    public void codexFileMatchRejectsNonJsonlExtension() {
        String sessionId = "019b690b-c87f-7350";
        Path wrongExt = Paths.get("/tmp/rollout-2025-12-29T15-38-58-" + sessionId + ".log");
        assertFalse(HistoryDeleteService.isCodexSessionFileMatch(wrongExt, sessionId));
    }
}
