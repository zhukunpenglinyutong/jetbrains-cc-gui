package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class GrokHistoryReaderRestoreTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void missingRestoreIsRetryableWhileLegacyListingKeepsItsEmptyFallback() throws Exception {
        GrokHistoryReader reader = new GrokHistoryReader(temporary.newFolder("sessions").toPath(), new Gson());
        assertTrue(reader.getSessionMessages("missing-session", "/fixture").isEmpty());
        assertThrows(SessionHistoryNotFoundException.class,
                () -> reader.getSessionMessages("missing-session", "/fixture", () -> false));
    }
}
