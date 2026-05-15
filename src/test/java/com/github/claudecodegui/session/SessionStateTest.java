package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SessionStateTest {

    @Test
    public void invalidatingPendingSendOperationsMarksEarlierEpochsAsStale() {
        SessionState state = new SessionState();

        long initialEpoch = state.capturePendingSendInvalidationEpoch();
        assertTrue(state.isPendingSendOperationCurrent(initialEpoch));

        state.invalidatePendingSendOperations();

        assertFalse(state.isPendingSendOperationCurrent(initialEpoch));
        assertTrue(state.isPendingSendOperationCurrent(state.capturePendingSendInvalidationEpoch()));
    }
}
