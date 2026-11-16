package com.github.claudecodegui.util;

import org.junit.Assert;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Tests the frame-rate choice for on-screen and off-screen OSR browsers without a live browser.
 */
public class OsrFrameRateLimiterTest {

    @Test
    public void defaultRegistryValueRestoresCefDefault() {
        Assert.assertEquals(OsrFrameRateLimiter.DEFAULT_FRAME_RATE, OsrFrameRateLimiter.visibleFrameRate(0));
        Assert.assertEquals(OsrFrameRateLimiter.DEFAULT_FRAME_RATE, OsrFrameRateLimiter.visibleFrameRate(-5));
    }

    @Test
    public void explicitRegistryValueWinsWithinChromiumLimit() {
        Assert.assertEquals(15, OsrFrameRateLimiter.visibleFrameRate(15));
        Assert.assertEquals(OsrFrameRateLimiter.MAX_FRAME_RATE, OsrFrameRateLimiter.visibleFrameRate(240));
    }

    @Test
    public void followsOnScreenState() {
        AtomicBoolean showing = new AtomicBoolean(false);
        List<Integer> applied = new ArrayList<>();
        OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(showing::get, applied::add, 0);

        limiter.apply();
        showing.set(true);
        limiter.apply();
        showing.set(false);
        limiter.apply();

        Assert.assertEquals(Arrays.asList(
                OsrFrameRateLimiter.HIDDEN_FRAME_RATE,
                OsrFrameRateLimiter.DEFAULT_FRAME_RATE,
                OsrFrameRateLimiter.HIDDEN_FRAME_RATE), applied);
    }

    @Test
    public void reappliesTheSameRateForLatePeerCreation() {
        AtomicBoolean showing = new AtomicBoolean(true);
        List<Integer> applied = new ArrayList<>();
        OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(showing::get, applied::add, 20);

        limiter.apply();
        limiter.apply();

        Assert.assertEquals(Arrays.asList(20, 20), applied);
    }
}
