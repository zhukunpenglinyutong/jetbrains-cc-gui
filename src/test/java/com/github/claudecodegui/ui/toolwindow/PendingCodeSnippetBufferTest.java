package com.github.claudecodegui.ui.toolwindow;

import org.junit.Assert;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Unit tests for {@link PendingCodeSnippetBuffer}, the defer-until-frontend-ready
 * buffer extracted from {@code ClaudeChatWindow} (PR #1206 follow-up).
 */
public class PendingCodeSnippetBufferTest {

    @Test
    public void offerEmitsImmediatelyWhenFrontendReady() {
        PendingCodeSnippetBuffer buffer = new PendingCodeSnippetBuffer();

        Assert.assertEquals("snippet", buffer.offer("snippet", true));
        // Nothing was deferred
        Assert.assertNull(buffer.takePending());
    }

    @Test
    public void offerDefersWhenFrontendNotReady() {
        PendingCodeSnippetBuffer buffer = new PendingCodeSnippetBuffer();

        // Deferred -> not emitted now
        Assert.assertNull(buffer.offer("snippet", false));
        // Flushed once the frontend is ready
        Assert.assertEquals("snippet", buffer.takePending());
    }

    @Test
    public void takePendingReturnsSnippetOnlyOnce() {
        PendingCodeSnippetBuffer buffer = new PendingCodeSnippetBuffer();
        buffer.offer("snippet", false);

        Assert.assertEquals("snippet", buffer.takePending());
        // Second flush gets nothing — guards against duplicate insertion
        Assert.assertNull(buffer.takePending());
    }

    @Test
    public void latestSnippetWinsWhenDeferredRepeatedly() {
        PendingCodeSnippetBuffer buffer = new PendingCodeSnippetBuffer();
        buffer.offer("first", false);
        buffer.offer("second", false);

        Assert.assertEquals("second", buffer.takePending());
    }

    @Test
    public void concurrentFlushEmitsDeferredSnippetExactlyOnce() throws InterruptedException {
        // ClaudeChatWindow registers setFrontendReady on two delegates; both call
        // flushPendingCodeSnippet(). This proves the atomic swap hands the snippet
        // to exactly one caller even under concurrent flushes — the bug the original
        // volatile check-then-act could not guarantee.
        PendingCodeSnippetBuffer buffer = new PendingCodeSnippetBuffer();
        buffer.offer("snippet", false);

        int threadCount = 16;
        CountDownLatch ready = new CountDownLatch(threadCount);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger nonNullResults = new AtomicInteger(0);
        Thread[] workers = new Thread[threadCount];

        for (int i = 0; i < threadCount; i++) {
            workers[i] = new Thread(() -> {
                ready.countDown();
                try {
                    start.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (buffer.takePending() != null) {
                    nonNullResults.incrementAndGet();
                }
            });
            workers[i].start();
        }

        ready.await();
        start.countDown();
        for (Thread worker : workers) {
            worker.join();
        }

        Assert.assertEquals(1, nonNullResults.get());
    }
}
