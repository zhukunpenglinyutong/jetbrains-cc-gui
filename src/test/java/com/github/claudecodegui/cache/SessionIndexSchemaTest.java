package com.github.claudecodegui.cache;

import com.google.gson.Gson;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies the v3 index schema: SessionIndexEntry serializes the new
 * fileLastModified + fileRelativePath fields and round-trips cleanly through Gson.
 * This is the contract that incremental scan depends on.
 */
public class SessionIndexSchemaTest {

    private final Gson gson = new Gson();

    @Test
    public void sessionIndexEntry_fileLastModified_roundTripsThroughGson() {
        SessionIndexManager.SessionIndexEntry entry = new SessionIndexManager.SessionIndexEntry();
        entry.sessionId = "aaaaaaaa-1111-4111-8111-111111111111";
        entry.title = "Hello";
        entry.messageCount = 3;
        entry.lastTimestamp = 1_700_000_000_000L;
        entry.firstTimestamp = 1_700_000_000_000L;
        entry.fileLastModified = 1_700_000_123_456L;
        entry.fileRelativePath = entry.sessionId + ".jsonl";

        String json = gson.toJson(entry);
        assertTrue("fileLastModified must be serialized", json.contains("\"fileLastModified\":1700000123456"));
        assertTrue("fileRelativePath must be serialized", json.contains("\"fileRelativePath\""));

        SessionIndexManager.SessionIndexEntry decoded = gson.fromJson(json, SessionIndexManager.SessionIndexEntry.class);
        assertEquals(entry.sessionId, decoded.sessionId);
        assertEquals(entry.fileLastModified, decoded.fileLastModified);
        assertEquals(entry.fileRelativePath, decoded.fileRelativePath);
    }

    @Test
    public void sessionIndexEntry_loadingV2Entry_defaultsFileMtimeToZero() {
        // v2 schema had no fileLastModified / fileRelativePath.
        String v2Json = "{"
                + "\"sessionId\":\"old-id\","
                + "\"title\":\"Legacy\","
                + "\"messageCount\":5,"
                + "\"lastTimestamp\":1000,"
                + "\"firstTimestamp\":999,"
                + "\"fileSize\":0"
                + "}";

        SessionIndexManager.SessionIndexEntry decoded = gson.fromJson(v2Json, SessionIndexManager.SessionIndexEntry.class);
        assertNotNull(decoded);
        assertEquals("old-id", decoded.sessionId);
        // Missing fields default to zero / null -- incrementalScanLite uses this to detect legacy entries.
        assertEquals(0L, decoded.fileLastModified);
        assertEquals(null, decoded.fileRelativePath);
    }

    @Test
    public void sessionIndex_wrapperDefaults_useCurrentVersion() {
        SessionIndexManager.SessionIndex freshIndex = new SessionIndexManager.SessionIndex();
        // Sanity: a freshly constructed index must advertise the active schema version.
        // When readIndex sees a mismatched version on disk it replaces the content with a blank
        // instance, so this default is what gets returned to callers after an upgrade.
        assertTrue("version should be at least 3", freshIndex.version >= 3);
    }
}
