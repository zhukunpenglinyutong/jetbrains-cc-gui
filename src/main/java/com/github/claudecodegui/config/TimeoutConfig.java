package com.github.claudecodegui.config;

import java.util.concurrent.TimeUnit;

/**
 * Unified timeout configuration.
 * Controls timeouts for all asynchronous operations.
 */
public class TimeoutConfig {
    /**
     * Quick operation timeout: 30 seconds.
     * Used for: channel startup, fetching command lists, etc.
     */
    public static final long QUICK_OPERATION_TIMEOUT = 30;
    public static final TimeUnit QUICK_OPERATION_UNIT = TimeUnit.SECONDS;

    /**
     * Message sending timeout: 3 minutes.
     * Used for: sending messages, AI responses, etc.
     */
    public static final long MESSAGE_TIMEOUT = 180;
    public static final TimeUnit MESSAGE_UNIT = TimeUnit.SECONDS;

    /**
     * Long operation timeout: 10 minutes.
     * Used for: file indexing, large-scale data processing, etc.
     */
    public static final long LONG_OPERATION_TIMEOUT = 600;
    public static final TimeUnit LONG_OPERATION_UNIT = TimeUnit.SECONDS;

    private TimeoutConfig() {
        // Utility class, not instantiable
    }
}
