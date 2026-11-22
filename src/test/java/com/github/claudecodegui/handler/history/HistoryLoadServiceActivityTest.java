package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class HistoryLoadServiceActivityTest {

    private static final String HISTORY = "{\"sessions\":[{\"sessionId\":\"current\"},{\"sessionId\":\"other\"},{\"sessionId\":\"idle\"}]}";

    @Test
    public void liveTurnsAndForeignWritersAreMarkedButIdleCurrentOwnersRemainDeletable() {
        ClaudeSession session = currentSession("codex");
        CodexSDKBridge bridge = new CodexSDKBridge() {
            @Override
            public boolean hasCodexThreadOwner(String id) {
                return !"idle".equals(id);
            }

            @Override
            public boolean ownsCodexThread(String id) {
                return "current".equals(id);
            }
        };
        var idle = rows(HistoryLoadService.enhanceHistoryWithActivity(HISTORY, "codex", session, bridge));
        assertFalse(idle[0].get("running").getAsBoolean());
        assertTrue(idle[1].get("running").getAsBoolean());
        assertFalse(idle[2].get("running").getAsBoolean());
        session.getState().beginTurn();
        assertTrue(rows(HistoryLoadService.enhanceHistoryWithActivity(HISTORY, "codex", session, bridge))[0].get("running").getAsBoolean());
    }

    @Test
    public void matchingIdsFromAnotherProviderDoNotMakeCodexSessionsBusy() {
        ClaudeSession session = currentSession("claude");
        session.getState().beginTurn();
        assertFalse(rows(HistoryLoadService.enhanceHistoryWithActivity(HISTORY, "codex", session, null))[0].get("running").getAsBoolean());
        assertEquals(HISTORY, HistoryLoadService.enhanceHistoryWithActivity(HISTORY, "claude", session, null));
    }

    @Test
    public void ownershipRemainsProtectedWithoutAnActiveSession() {
        CodexSDKBridge bridge = new CodexSDKBridge() {
            @Override
            public boolean hasCodexThreadOwner(String id) {
                return "other".equals(id);
            }
        };
        var rows = rows(HistoryLoadService.enhanceHistoryWithActivity(HISTORY, "codex", null, bridge));
        assertFalse(rows[0].get("running").getAsBoolean());
        assertTrue(rows[1].get("running").getAsBoolean());
    }

    @Test
    public void foreignWritersAreDistinguishedFromTheLocalTurn() {
        ClaudeSession session = currentSession("codex");
        session.getState().beginTurn();
        CodexSDKBridge bridge = new CodexSDKBridge() {
            @Override
            public boolean hasCodexThreadOwner(String id) {
                return !"idle".equals(id);
            }

            @Override
            public boolean ownsCodexThread(String id) {
                return "current".equals(id);
            }
        };
        var rows = rows(HistoryLoadService.enhanceHistoryWithActivity(HISTORY, "codex", session, bridge));
        assertTrue(rows[0].get("running").getAsBoolean());
        assertFalse("a local turn is not a foreign writer", rows[0].has("ownedElsewhere"));
        assertTrue(rows[1].get("ownedElsewhere").getAsBoolean());
        assertFalse(rows[2].has("ownedElsewhere"));
    }

    @Test
    public void malformedRowsAreSkippedAndUnreadableHistoryIsReturnedUnchanged() {
        String history = "{\"sessions\":[\"text\",{\"title\":\"no id\"},{\"sessionId\":\"idle\",\"running\":\"yes\"}]}";
        var rows = JsonParser.parseString(HistoryLoadService.enhanceHistoryWithActivity(history, "codex", null, null))
                .getAsJsonObject().getAsJsonArray("sessions");
        assertFalse(rows.get(1).getAsJsonObject().has("running"));
        assertFalse(rows.get(2).getAsJsonObject().get("running").getAsBoolean());
        assertEquals("not json", HistoryLoadService.enhanceHistoryWithActivity("not json", "codex", null, null));
        assertEquals("", HistoryLoadService.enhanceHistoryWithActivity("", "codex", null, null));
    }

    private static JsonObject[] rows(String json) {
        return JsonParser.parseString(json).getAsJsonObject().getAsJsonArray("sessions").asList()
                .stream().map(value -> value.getAsJsonObject()).toArray(JsonObject[]::new);
    }

    private static ClaudeSession currentSession(String provider) {
        return new ClaudeSession(null, null, null, null) {
            @Override
            public String getSessionId() {
                return "current";
            }

            @Override
            public String getProvider() {
                return provider;
            }
        };
    }
}
