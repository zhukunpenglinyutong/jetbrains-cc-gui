package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class RestoredHistorySessionTest {
    @Test
    public void failedAttemptStaysRecordedUntilAnotherSessionIsBound() {
        RestoredHistorySession<Object> restore = new RestoredHistorySession<>();
        Object session = new Object();
        restore.bind(session, "restored");
        assertFalse(restore.wasAttempted());
        restore.markAttempted();
        assertTrue(restore.wasAttempted());
        assertTrue(restore.isCurrent(session, "restored"));
        restore.bind(new Object(), "other");
        assertFalse(restore.wasAttempted());
    }

    @Test
    public void committedRestoreRemainsCompleteWhileUiDeliveryAndTabReactivationArePending() {
        RestoredHistorySession<Object> restore = new RestoredHistorySession<>();
        Object session = new Object();
        restore.bind(session, "restored");
        assertTrue(restore.isCurrent(session, "restored"));
        restore.markCommitted(session, "restored");
        // The background read is done; the UI completion callback has not run yet.
        assertFalse(restore.isCurrent(session, "restored"));
        restore.complete(session, "restored");
        assertFalse(restore.isCurrent(new Object(), "other-tab"));
        assertFalse(restore.isCurrent(session, "restored"));
    }

    @Test
    public void retiringTheBindingEndsTheRestoreForEverySession() {
        RestoredHistorySession<Object> restore = new RestoredHistorySession<>();
        Object session = new Object();
        restore.bind(session, "restored");
        restore.markAttempted();

        restore.retire();

        assertFalse(restore.isCurrent(session, "restored"));
        assertNull(restore.sessionId());
    }

    @Test
    public void anOrdinaryLoadSettlesOnlyTheCurrentBinding() {
        RestoredHistorySession<Object> restore = new RestoredHistorySession<>();
        Object session = new Object();
        restore.bind(session, "restored");

        assertFalse(restore.settleByOrdinaryLoad(new Object(), "restored"));
        assertFalse(restore.settleByOrdinaryLoad(session, "other"));
        assertTrue(restore.isCurrent(session, "restored"));

        assertTrue(restore.settleByOrdinaryLoad(session, "restored"));
        assertFalse(restore.isCurrent(session, "restored"));
        // The id stays readable until the UI has published the settled state.
        assertEquals("restored", restore.sessionId());
        assertFalse(restore.settleByOrdinaryLoad(session, "restored"));
    }

    @Test
    public void obsoleteCompletionCannotRetireAnotherRestoreBinding() {
        RestoredHistorySession<Object> restore = new RestoredHistorySession<>();
        Object original = new Object();
        Object replacement = new Object();
        restore.bind(original, "same-id");
        restore.bind(replacement, "same-id");
        restore.complete(original, "same-id");
        assertTrue(restore.isCurrent(replacement, "same-id"));
    }
}
