package com.github.claudecodegui.cli;

import org.junit.Test;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CliSessionExecutorTest {

    @Test
    public void cliExecutorRunsIndependentTabTasksConcurrently() throws Exception {
        CountDownLatch entered = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        Set<String> threadNames = ConcurrentHashMap.newKeySet();

        var first = CliSessionExecutor.runAsync(() -> awaitBothTabs(entered, release, threadNames));
        var second = CliSessionExecutor.runAsync(() -> awaitBothTabs(entered, release, threadNames));

        assertTrue("both CLI tasks should start without waiting for the other to finish",
                entered.await(2, TimeUnit.SECONDS));
        release.countDown();

        first.get(2, TimeUnit.SECONDS);
        second.get(2, TimeUnit.SECONDS);

        assertEquals("independent CLI tasks should not share a single worker thread", 2, threadNames.size());
    }

    private static void awaitBothTabs(
            CountDownLatch entered,
            CountDownLatch release,
            Set<String> threadNames
    ) {
        threadNames.add(Thread.currentThread().getName());
        entered.countDown();
        try {
            assertTrue(release.await(2, TimeUnit.SECONDS));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AssertionError(e);
        }
    }
}
