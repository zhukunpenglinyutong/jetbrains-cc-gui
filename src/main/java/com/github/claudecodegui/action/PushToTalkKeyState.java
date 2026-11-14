package com.github.claudecodegui.action;

/**
 * Tells a new press of the push-to-talk shortcut from the auto-repeat of a key that is still held.
 *
 * <p>Holding a key makes the IDE invoke the action again for every auto-repeat, starting after the
 * OS repeat delay (500–660 ms by default). While no release has been seen, every invocation is a
 * repeat; a hold older than {@link #MAX_HOLD_MS} is treated as a missed release.
 */
final class PushToTalkKeyState {

    /** Longer than the 5-minute recording cap, so only a lost key-up can get here. */
    static final long MAX_HOLD_MS = 10 * 60 * 1000L;

    private boolean held;
    private long pressedAt;

    /** Records a press; returns true for a new press and false for an auto-repeat. */
    boolean press(long now) {
        if (held && now - pressedAt < MAX_HOLD_MS) {
            return false;
        }
        held = true;
        pressedAt = now;
        return true;
    }

    /** Records that the key went up (or focus left the IDE, which hides the key-up). */
    void release() {
        held = false;
    }

    boolean isHeld() {
        return held;
    }
}
