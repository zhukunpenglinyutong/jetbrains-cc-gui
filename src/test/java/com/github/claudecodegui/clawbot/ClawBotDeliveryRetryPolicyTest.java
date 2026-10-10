package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClawBotDeliveryRetryPolicyTest {

    @Test
    public void retryDelayDoublesAndCapsAtOneMinute() {
        assertEquals(TimeUnit.SECONDS.toNanos(1), ClawBotDeliveryRetryPolicy.delayNanos(1));
        assertEquals(TimeUnit.SECONDS.toNanos(2), ClawBotDeliveryRetryPolicy.delayNanos(2));
        assertEquals(TimeUnit.SECONDS.toNanos(4), ClawBotDeliveryRetryPolicy.delayNanos(3));
        assertEquals(TimeUnit.SECONDS.toNanos(60), ClawBotDeliveryRetryPolicy.delayNanos(7));
        assertEquals(TimeUnit.SECONDS.toNanos(60), ClawBotDeliveryRetryPolicy.delayNanos(31));
    }

    @Test
    public void retryDueComparisonSupportsNanoTimeWraparound() {
        long retryAt = Long.MIN_VALUE + 2L;

        assertFalse(ClawBotDeliveryRetryPolicy.isDue(Long.MAX_VALUE - 2L, retryAt));
        assertTrue(ClawBotDeliveryRetryPolicy.isDue(Long.MIN_VALUE + 3L, retryAt));
    }
}
