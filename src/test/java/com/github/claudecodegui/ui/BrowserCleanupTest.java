package com.github.claudecodegui.ui;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class BrowserCleanupTest {
    @Test
    public void failedNativeDisposalRemainsOwnedUntilExplicitRetrySucceeds() {
        AtomicBoolean fail = new AtomicBoolean(true);
        AtomicInteger calls = new AtomicInteger();
        Object browser = new Object();
        BrowserCleanup<Object> cleanup = new BrowserCleanup<>(resource -> {
            assertTrue(resource == browser);
            calls.incrementAndGet();
            if (fail.get()) {
                throw new IllegalStateException("Transient native disposal failure");
            }
        });

        assertFalse(cleanup.dispose(browser));
        assertTrue(cleanup.hasPendingCleanup());
        cleanup.retry();
        assertEquals(2, calls.get());
        assertTrue(cleanup.hasPendingCleanup());

        fail.set(false);
        cleanup.retry();
        assertFalse(cleanup.hasPendingCleanup());
        cleanup.retry();
        assertEquals(3, calls.get());
    }

    @Test
    public void nativeLinkageErrorsAlsoBlockReplacementUntilCleanupSucceeds() {
        AtomicBoolean fail = new AtomicBoolean(true);
        BrowserCleanup<Object> cleanup = new BrowserCleanup<>(browser -> {
            if (fail.getAndSet(false)) {
                throw new UnsatisfiedLinkError("Native browser temporarily unavailable");
            }
        });

        assertFalse(cleanup.dispose(new Object()));
        assertTrue(cleanup.hasPendingCleanup());
        cleanup.retry();
        assertFalse(cleanup.hasPendingCleanup());
    }

    @Test
    public void windowCleanupReleasesBothQuarantinedAndCurrentBrowsers() {
        Object failedBrowser = new Object();
        Object currentBrowser = new Object();
        List<Object> disposed = new ArrayList<>();
        BrowserCleanup<Object> cleanup = new BrowserCleanup<>(disposed::add);
        cleanup.retain(failedBrowser);
        cleanup.retain(currentBrowser);
        cleanup.retain(failedBrowser);

        cleanup.retry();

        assertEquals(2, disposed.size());
        assertTrue(disposed.contains(failedBrowser));
        assertTrue(disposed.contains(currentBrowser));
        assertFalse(cleanup.hasPendingCleanup());
    }

    @Test
    public void nativeEventPumpingCannotReenterDisposalOrUnblockBrowserCreation() {
        Object browser = new Object();
        AtomicReference<BrowserCleanup<Object>> owner = new AtomicReference<>();
        AtomicInteger calls = new AtomicInteger();
        BrowserCleanup<Object> cleanup = new BrowserCleanup<>(resource -> {
            calls.incrementAndGet();
            assertTrue(owner.get().hasPendingCleanup());
            owner.get().retry();
            assertTrue(owner.get().hasPendingCleanup());
        });
        owner.set(cleanup);

        assertTrue(cleanup.dispose(browser));
        assertEquals(1, calls.get());
        assertFalse(cleanup.hasPendingCleanup());
    }

    @Test
    public void oneFailedCleanupDoesNotPreventDisposingOtherOwnedBrowsers() {
        Object failedBrowser = new Object();
        Object otherBrowser = new Object();
        List<Object> disposed = new ArrayList<>();
        BrowserCleanup<Object> cleanup = new BrowserCleanup<>(resource -> {
            if (resource == failedBrowser) {
                throw new IllegalStateException("Still unavailable");
            }
            disposed.add(resource);
        });
        cleanup.retain(failedBrowser);
        cleanup.retain(otherBrowser);

        cleanup.retry();

        assertEquals(List.of(otherBrowser), disposed);
        assertTrue(cleanup.hasPendingCleanup());
    }
}
