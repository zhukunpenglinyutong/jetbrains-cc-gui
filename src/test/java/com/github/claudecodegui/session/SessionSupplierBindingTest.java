package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class SessionSupplierBindingTest {
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
}
