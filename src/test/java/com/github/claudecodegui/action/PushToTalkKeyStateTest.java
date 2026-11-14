package com.github.claudecodegui.action;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PushToTalkKeyStateTest {

    @Test
    public void autoRepeatAfterTheOsDelayIsStillTheSameHold() {
        PushToTalkKeyState state = new PushToTalkKeyState();

        assertTrue(state.press(0));
        // X.Org waits 660 ms before the first repeat, then repeats every ~40 ms.
        assertFalse(state.press(660));
        assertFalse(state.press(700));
        assertFalse(state.press(30_000));
        assertTrue(state.isHeld());
    }

    @Test
    public void pressAfterReleaseIsNew() {
        PushToTalkKeyState state = new PushToTalkKeyState();
        state.press(0);

        state.release();

        assertFalse(state.isHeld());
        assertTrue(state.press(100));
    }

    @Test
    public void holdOlderThanTheCapCountsAsMissedRelease() {
        PushToTalkKeyState state = new PushToTalkKeyState();
        state.press(0);

        assertTrue(state.press(PushToTalkKeyState.MAX_HOLD_MS + 1));
    }
}
