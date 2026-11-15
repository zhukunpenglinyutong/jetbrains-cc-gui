package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the automatic retry that follows a live-narrative reload rejection.
 *
 * <p>Why this matters: the guard correctly refuses to replace the on-screen
 * transcript with a shorter one, but before this retry a rejection ended the
 * reload for good. The frontend can drop a live inter-turn event, so the
 * reload is its only fallback; a bounded retry lets it heal once the CLI has
 * flushed the follow-up turn to JSONL.</p>
 */
public class LiveNarrativeRetryTest {

    @Test
    public void allowsRetriesUpToTheBound() {
        assertTrue(SessionMessageOrchestrator.shouldScheduleLiveNarrativeRetry(1));
        assertTrue(SessionMessageOrchestrator.shouldScheduleLiveNarrativeRetry(2));
        assertFalse("third attempt is refused", SessionMessageOrchestrator.shouldScheduleLiveNarrativeRetry(3));
        assertFalse(SessionMessageOrchestrator.shouldScheduleLiveNarrativeRetry(4));
    }

    @Test
    public void runsForTheDisplayedSessionWhenIdle() {
        assertTrue(SessionMessageOrchestrator.shouldRunLiveNarrativeRetry("s1", "s1", false, false));
    }

    @Test
    public void skipsWhenTheSessionChanged() {
        assertFalse(SessionMessageOrchestrator.shouldRunLiveNarrativeRetry("s2", "s1", false, false));
    }

    @Test
    public void skipsWhileBusyOrLoading() {
        assertFalse(SessionMessageOrchestrator.shouldRunLiveNarrativeRetry("s1", "s1", true, false));
        assertFalse(SessionMessageOrchestrator.shouldRunLiveNarrativeRetry("s1", "s1", false, true));
    }

    @Test
    public void skipsWhenNoSessionIsRequested() {
        assertFalse(SessionMessageOrchestrator.shouldRunLiveNarrativeRetry(null, null, false, false));
        assertFalse(SessionMessageOrchestrator.shouldRunLiveNarrativeRetry("s1", null, false, false));
    }
}
