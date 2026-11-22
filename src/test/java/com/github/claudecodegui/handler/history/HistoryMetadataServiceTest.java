package com.github.claudecodegui.handler.history;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class HistoryMetadataServiceTest {

    @Test
    public void extractCustomTitleReturnsSavedTitle() {
        String titlesJson = "{\"session-one\":{\"customTitle\":\"Saved by hand\",\"updatedAt\":1}}";
        assertEquals("Saved by hand", HistoryMetadataService.extractCustomTitle(titlesJson, "session-one"));
    }

    @Test
    public void extractCustomTitleIgnoresUnknownSession() {
        String titlesJson = "{\"session-one\":{\"customTitle\":\"Saved by hand\"}}";
        assertNull(HistoryMetadataService.extractCustomTitle(titlesJson, "session-two"));
    }

    @Test
    public void extractCustomTitleTreatsBlankAsAbsent() {
        String titlesJson = "{\"session-one\":{\"customTitle\":\"   \"}}";
        assertNull(HistoryMetadataService.extractCustomTitle(titlesJson, "session-one"));
    }

    @Test
    public void extractCustomTitleHandlesMissingOrInvalidPayload() {
        assertNull(HistoryMetadataService.extractCustomTitle("{}", "session-one"));
        assertNull(HistoryMetadataService.extractCustomTitle("not-json", "session-one"));
        assertNull(HistoryMetadataService.extractCustomTitle(
                "{\"session-one\":{\"updatedAt\":1}}", "session-one"));
    }
}
