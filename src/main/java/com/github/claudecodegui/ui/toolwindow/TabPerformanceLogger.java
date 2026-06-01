package com.github.claudecodegui.ui.toolwindow;

import java.util.concurrent.TimeUnit;

public final class TabPerformanceLogger {

    private TabPerformanceLogger() {
    }

    public static long elapsedMillis(long startNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNanos);
    }

    public static String describeTab(String tabName, String sessionId) {
        String resolvedTabName = (tabName == null || tabName.trim().isEmpty()) ? "<unknown>" : tabName.trim();
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return "tab=" + resolvedTabName;
        }
        return "tab=" + resolvedTabName + ", session=" + sessionId.trim();
    }
}
