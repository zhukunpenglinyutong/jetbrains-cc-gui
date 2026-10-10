package com.github.claudecodegui.clawbot;

import java.util.concurrent.TimeUnit;

/** Bounded exponential retry delay for known, retryable outbound failures. */
public final class ClawBotDeliveryRetryPolicy {

    private static final int MAX_EXPONENT = 6;
    private static final long MAX_DELAY_SECONDS = 60L;

    private ClawBotDeliveryRetryPolicy() {
    }

    public static long delayNanos(int failureCount) {
        if (failureCount < 1) {
            throw new IllegalArgumentException("failureCount must be positive");
        }
        int exponent = Math.min(failureCount - 1, MAX_EXPONENT);
        return TimeUnit.SECONDS.toNanos(Math.min(1L << exponent, MAX_DELAY_SECONDS));
    }

    public static boolean isDue(long nowNanos, long retryAtNanos) {
        return nowNanos - retryAtNanos >= 0L;
    }
}
