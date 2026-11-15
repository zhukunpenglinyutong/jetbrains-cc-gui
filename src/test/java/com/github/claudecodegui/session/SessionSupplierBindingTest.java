package com.github.claudecodegui.session;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.SessionSupplierCatalog;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class SessionSupplierBindingTest {
    @Test
    public void anUnconfiguredConversationPicksUpTheFirstSupplierForEachEngine() {
        ClaudeSession session = new ClaudeSession(null, null, null, java.util.Map.of());
        FakeSettings settings = new FakeSettings();
        session.initializeSupplierDefaults(settings);
        assertEquals(SessionSupplierCatalog.UNAVAILABLE, session.getState().getSupplierId("claude"));
        assertEquals(SessionSupplierCatalog.UNAVAILABLE, session.getState().getSupplierId("codex"));

        settings.claude = supplier("first-claude");
        settings.codex = supplier("first-codex");
        session.initializeSupplierDefaults(settings);
        assertEquals("first-claude", session.getState().getSupplierId("claude"));
        assertEquals("first-codex", session.getState().getSupplierId("codex"));

        settings.claude = supplier("new-global-default");
        settings.codex = null;
        session.initializeSupplierDefaults(settings);
        assertEquals("first-claude", session.getState().getSupplierId("claude"));
        assertEquals("first-codex", session.getState().getSupplierId("codex"));
    }

    @Test
    public void readingDefaultsCannotOverwriteAnExplicitSelectionMadeWhileReading() {
        ClaudeSession session = new ClaudeSession(null, null, null, java.util.Map.of());
        FakeSettings settings = new FakeSettings() {
            @Override
            public JsonObject getActiveClaudeProvider() {
                session.getState().setSupplierId("claude", "explicit-choice");
                return supplier("global-default");
            }
        };
        session.initializeSupplierDefaults(settings);
        assertEquals("explicit-choice", session.getState().getSupplierId("claude"));
    }

    @Test
    public void firstSupplierRecoveryDoesNotRedirectAnAlreadyCapturedTurn() {
        ClaudeSession session = new ClaudeSession(null, null, null, java.util.Map.of());
        FakeSettings settings = new FakeSettings();
        session.initializeSupplierDefaults(settings);
        session.getState().beginTurn();
        settings.claude = supplier("first-claude");
        session.initializeSupplierDefaults(settings);
        assertEquals("first-claude", session.getState().getSupplierId("claude"));
        assertEquals(SessionSupplierCatalog.UNAVAILABLE, session.getState().getRuntimeSupplierId("claude"));
        session.getState().beginTurn();
        assertEquals("first-claude", session.getState().getRuntimeSupplierId("claude"));
    }

    @Test
    public void switchingDuringTurnDefersRoutingUntilTheNextTurn() {
        SessionState state = new SessionState();
        state.setSupplierId("claude", "supplier-a");
        state.beginTurn();
        state.setSupplierId("claude", "supplier-b");
        assertEquals("supplier-b", state.getSupplierId("claude"));
        assertEquals("supplier-a", state.getRuntimeSupplierId("claude"));
        state.setBusy(false);
        assertEquals("supplier-a", state.getRuntimeSupplierId("claude"));
        state.beginTurn();
        assertEquals("supplier-b", state.getRuntimeSupplierId("claude"));
    }

    @Test
    public void restoringATabPreservesAnExplicitSupplierBeforePublishingItsIdentity() {
        ClaudeSession session = new ClaudeSession(null, null, null, java.util.Map.of());
        session.getState().setSupplierId("claude", "global-default");
        session.setSessionInfo("restored-history", null, null, "saved-supplier");
        assertEquals("saved-supplier", session.getState().getSupplierId("claude"));
        assertEquals("restored-history", session.getSessionId());
    }

    @Test
    public void simultaneousSessionsAndEnginesKeepIndependentSelections() {
        SessionState a = new SessionState();
        SessionState b = new SessionState();
        a.setProvider("codex");
        b.setProvider("codex");
        a.setSupplierId("codex", "codex-a");
        a.setSupplierId("claude", "claude-a");
        b.setSupplierId("codex", "codex-b");
        a.beginTurn();
        b.beginTurn();
        a.setSupplierId("codex", "codex-next");
        assertEquals("codex-a", a.getRuntimeSupplierId("codex"));
        assertEquals("claude-a", a.getSupplierId("claude"));
        assertEquals("codex-b", b.getRuntimeSupplierId("codex"));
    }

    private static JsonObject supplier(String id) {
        JsonObject supplier = new JsonObject();
        supplier.addProperty("id", id);
        return supplier;
    }

    private static class FakeSettings extends CodemossSettingsService {
        private JsonObject claude;
        private JsonObject codex;

        @Override
        public JsonObject getActiveClaudeProvider() {
            return claude;
        }

        @Override
        public JsonObject getActiveCodexProvider() {
            return codex;
        }
    }
}
