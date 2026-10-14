package com.github.claudecodegui.clawbot;

import java.util.concurrent.TimeUnit;

final class ClawBotSessionIdleClock {

    private static final long ACTIVITY_LEASE_MILLIS = 15_000;
    private long observedAt;
    private long activeUntil;
    private long idleNanos;
    private boolean invalid;

    ClawBotSessionIdleClock(long now) {
        observedAt = now;
        activeUntil = now;
    }

    long observe(long now) {
        if (now < observedAt) {
            invalid = true;
        }
        if (invalid) {
            return Long.MAX_VALUE;
        }
        long elapsed = now - Math.max(observedAt, activeUntil);
        if (elapsed > 0) {
            idleNanos = elapsed > Long.MAX_VALUE - idleNanos ? Long.MAX_VALUE : idleNanos + elapsed;
        }
        observedAt = now;
        return TimeUnit.NANOSECONDS.toMillis(idleNanos);
    }

    void report(boolean active, long now) {
        observe(now);
        activeUntil = active ? now + TimeUnit.MILLISECONDS.toNanos(ACTIVITY_LEASE_MILLIS) : now;
    }
}
