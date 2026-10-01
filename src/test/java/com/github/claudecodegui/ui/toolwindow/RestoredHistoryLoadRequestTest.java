package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class RestoredHistoryLoadRequestTest {

    @Test
    public void activeRequestCommitsOnlyBeforeCancellation() {
        AtomicBoolean owner = new AtomicBoolean(true);
        AtomicInteger commits = new AtomicInteger();
        RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(7L, owner::get);

        assertTrue(request.commitIfActive(commits::incrementAndGet));
        assertEquals(1, commits.get());
        assertTrue(request.cancel(RestoredHistoryLoadRequest.CANCELLED));
        assertFalse(request.commitIfActive(commits::incrementAndGet));
        assertEquals(1, commits.get());
        assertEquals(RestoredHistoryLoadRequest.CANCELLED, request.cancellationCode());
    }

    @Test
    public void staleOwnerCannotCommitEvenWithoutExplicitCancellation() {
        AtomicBoolean owner = new AtomicBoolean(false);
        AtomicInteger commits = new AtomicInteger();
        RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(8L, owner::get);

        assertTrue(request.isCancelled());
        assertFalse(request.commitIfActive(commits::incrementAndGet));
        assertEquals(0, commits.get());
    }

    @Test
    public void remembersCommitWhenTimeoutWinsFutureCompletionRace() {
        RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(9L, () -> true);

        assertTrue(request.commitIfActive(() -> { }));
        assertTrue(request.cancel(RestoredHistoryLoadRequest.TIMEOUT));
        assertTrue(request.wasCommitted());
    }

    @Test
    public void classifiesHistoryLoadFailuresAcrossWrappedCauses() {
        assertEquals("HISTORY_LOAD_PROVIDER_TIMEOUT",
                ClaudeChatWindow.historyLoadErrorCode(new CompletionException(new TimeoutException())));
        assertEquals("HISTORY_LOAD_PERMISSION_DENIED",
                ClaudeChatWindow.historyLoadErrorCode(
                        new IllegalStateException(new java.nio.file.AccessDeniedException("history"))));
        assertEquals("HISTORY_LOAD_NOT_FOUND",
                ClaudeChatWindow.historyLoadErrorCode(
                        new IllegalStateException(new java.io.IOException("Session file not found"))));
        assertEquals("HISTORY_LOAD_PROVIDER_ERROR",
                ClaudeChatWindow.historyLoadErrorCode(new IllegalStateException("provider failed")));
    }
}
