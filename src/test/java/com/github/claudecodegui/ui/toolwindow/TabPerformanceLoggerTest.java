package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class TabPerformanceLoggerTest {

    @Test
    public void describeTabUsesFallbackWhenTabNameMissing() {
        assertEquals("tab=<unknown>", TabPerformanceLogger.describeTab(null, null));
        assertEquals("tab=<unknown>", TabPerformanceLogger.describeTab("  ", ""));
    }

    @Test
    public void describeTabIncludesSessionIdWhenPresent() {
        assertEquals("tab=AI2, session=thread-123",
                TabPerformanceLogger.describeTab("AI2", "thread-123"));
    }

    @Test
    public void elapsedMillisUsesMonotonicClockDelta() {
        long startNanos = System.nanoTime() - 5_000_000L;

        assertTrue("Elapsed duration should be non-negative",
                TabPerformanceLogger.elapsedMillis(startNanos) >= 0L);
    }
}
