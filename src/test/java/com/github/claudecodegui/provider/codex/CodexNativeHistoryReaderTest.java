package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Guards native display conversion and the restricted offline fallback boundary. */
public class CodexNativeHistoryReaderTest {
    @Test
    public void keepsToolReasoningIdentityAndUserTextWhileRemovingInternalRows() {
        JsonArray input = JsonParser.parseString("""
                [{"type":"assistant","raw":{"uuid":"tool","codexItemId":"item","message":{"content":[
                  {"type":"tool_use","id":"item","name":"bash","input":{"command":"pwd"}},
                  {"type":"thinking","thinking":"stored thoughts"}]}}},
                 {"type":"user","raw":{"message":{"content":[{"type":"text","text":
                  "<external_codex_apps_open_page>{\\"page_id\\":null}</external_codex_apps_open_page>"}]}}},
                 {"type":"user","raw":{"message":{"content":[{"type":"text","text":
                  "<external_codex_apps_open_page>hidden</external_codex_apps_open_page>actual user"}]}}}]
                """).getAsJsonArray();
        var result = CodexNativeHistoryReader.normalizeMessages(input, "fixture-native-history");
        assertEquals(2, result.size());
        assertTrue(result.get(0).toString().contains("stored thoughts"));
        assertTrue(result.get(0).toString().contains("tool_use"));
        assertEquals("actual user", result.get(result.size() - 1).get("content").getAsString());
        assertFalse(result.toString().contains("external_codex_apps_open_page"));
        assertTrue(input.toString().contains("external_codex_apps_open_page"));
    }

    @Test
    public void authenticationAndWriterErrorsNeverSelectOfflineExecutionOrHistory() {
        assertFalse(CodexNativeHistoryReader.permitsOfflineFallback("Authentication failed"));
        assertFalse(CodexNativeHistoryReader.permitsOfflineFallback("Thread already owned by another window"));
        assertFalse(CodexNativeHistoryReader.permitsOfflineFallback("Unsupported native policy"));
        assertTrue(CodexNativeHistoryReader.permitsOfflineFallback("Codex runtime access is inactive"));
        assertTrue(CodexNativeHistoryReader.permitsOfflineFallback("Codex CLI not found"));
    }

    /** Actual child exit diagnostics permit reading persisted history without reopening a writer. */
    @Test
    public void actualNativeExitMessagesSelectOnlyPersistedHistory() {
        assertTrue(CodexNativeHistoryReader.permitsOfflineFallback("codex app-server exited (code=0, signal=null)"));
        assertTrue(CodexNativeHistoryReader.permitsOfflineFallback("codex app-server exited (code=1, signal=null)"));
        assertTrue(CodexNativeHistoryReader.permitsOfflineFallback("codex app-server exited (code=null, signal=SIGTERM)"));
        assertFalse(CodexNativeHistoryReader.permitsOfflineFallback("thread fixture already has an active writer"));
        assertFalse(CodexNativeHistoryReader.permitsOfflineFallback("Authentication failed: codex app-server exited"));
        assertFalse(CodexNativeHistoryReader.permitsOfflineFallback("codex app-server exited unexpectedly"));
        assertFalse(CodexNativeHistoryReader.permitsOfflineFallback("codex app-server exited (code=writer, signal=null)"));
        // The runtime layer wraps the exit line with a prefix, per-CLI diagnostics
        // and a remediation hint; the transport outage still permits the
        // read-only fallback.
        assertTrue(CodexNativeHistoryReader.permitsOfflineFallback("codex runtime failure: codex app-server exited (code=1, signal=null)"));
        assertTrue(CodexNativeHistoryReader.permitsOfflineFallback("codex runtime failure: codex app-server exited (code=1, signal=null)\n"
                + "  \u00b7 /usr/local/bin/codex \u2192 codex app-server exited (code=1, signal=null) \u2014 spawn ENOENT\n"
                + "  \u00b7 Codex CLI check: run `codex --version`"));
    }
}
