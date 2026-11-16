package com.github.claudecodegui.util;

import org.junit.Assert;
import org.junit.Test;

import java.awt.event.HierarchyEvent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
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
    public void explicitRegistryValueIsKeptAsIs() {
        Assert.assertEquals(15, OsrFrameRateLimiter.visibleFrameRate(15));
        // CEF has no 60 fps cap for windowless rendering since 2021, so a high-refresh choice must survive.
        Assert.assertEquals(120, OsrFrameRateLimiter.visibleFrameRate(120));
    }

    @Test
    public void hiddenRateKeepsTheReturnToScreenStallShort() {
        // A pending frame tick at the hidden rate delays the first frame after the browser is shown again.
        Assert.assertTrue(1000 / OsrFrameRateLimiter.HIDDEN_FRAME_RATE <= 200);
        Assert.assertTrue(OsrFrameRateLimiter.HIDDEN_FRAME_RATE < OsrFrameRateLimiter.DEFAULT_FRAME_RATE);
    }

    @Test
    public void appliesNothingBeforeTheNativePeerExists() {
        AtomicBoolean showing = new AtomicBoolean(true);
        List<Integer> applied = new ArrayList<>();
        OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(showing::get, applied::add, 0);

        limiter.onHierarchyChanged(HierarchyEvent.SHOWING_CHANGED);

        Assert.assertEquals(Collections.emptyList(), applied);
    }

    @Test
    public void peerCreationAppliesTheCurrentState() {
        AtomicBoolean showing = new AtomicBoolean(false);
        List<Integer> applied = new ArrayList<>();
        OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(showing::get, applied::add, 20);

        limiter.onPeerCreated();

        Assert.assertEquals(Collections.singletonList(OsrFrameRateLimiter.HIDDEN_FRAME_RATE), applied);
    }

    @Test
    public void followsOnScreenStateAfterPeerCreation() {
        AtomicBoolean showing = new AtomicBoolean(true);
        List<Integer> applied = new ArrayList<>();
        OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(showing::get, applied::add, 0);
        limiter.onPeerCreated();

        showing.set(false);
        limiter.onHierarchyChanged(HierarchyEvent.SHOWING_CHANGED);
        showing.set(true);
        limiter.onHierarchyChanged(HierarchyEvent.SHOWING_CHANGED | HierarchyEvent.PARENT_CHANGED);

        Assert.assertEquals(Arrays.asList(
                OsrFrameRateLimiter.DEFAULT_FRAME_RATE,
                OsrFrameRateLimiter.HIDDEN_FRAME_RATE,
                OsrFrameRateLimiter.DEFAULT_FRAME_RATE), applied);
    }

    @Test
    public void ignoresHierarchyChangesThatDoNotTouchShowing() {
        AtomicBoolean showing = new AtomicBoolean(true);
        List<Integer> applied = new ArrayList<>();
        OsrFrameRateLimiter limiter = new OsrFrameRateLimiter(showing::get, applied::add, 0);
        limiter.onPeerCreated();
        applied.clear();

        limiter.onHierarchyChanged(HierarchyEvent.PARENT_CHANGED | HierarchyEvent.DISPLAYABILITY_CHANGED);

        Assert.assertEquals(Collections.emptyList(), applied);
    }
}
