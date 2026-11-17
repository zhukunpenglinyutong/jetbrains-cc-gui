package com.github.claudecodegui.handler;

import org.junit.Test;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class TokenTrackerHandlerVersionTest {

    @Test
    public void parsesVersionFromCliOutputAndPackageSpec() {
        assertArrayEquals(new int[] {1, 5, 4}, TokenTrackerHandler.parseVersion("v1.5.4"));
        assertArrayEquals(new int[] {1, 5, 4}, TokenTrackerHandler.parseVersion("tokentracker-cli@1.5.4"));
        assertArrayEquals(new int[] {1, 10, 0}, TokenTrackerHandler.parseVersion("1.10.0-beta.2"));
        assertNull(TokenTrackerHandler.parseVersion("unknown"));
        assertNull(TokenTrackerHandler.parseVersion(null));
    }

    @Test
    public void treatsOlderOrUnknownVersionsAsOutdated() {
        assertFalse(TokenTrackerHandler.isAtLeastMinVersion("v0.87.3"));
        assertFalse(TokenTrackerHandler.isAtLeastMinVersion("1.4.7"));
        assertFalse(TokenTrackerHandler.isAtLeastMinVersion("1.5.3"));
        assertFalse(TokenTrackerHandler.isAtLeastMinVersion("unknown"));
        assertFalse(TokenTrackerHandler.isAtLeastMinVersion(null));
    }

    @Test
    public void acceptsThePinnedVersionAndNewer() {
        assertTrue(TokenTrackerHandler.isAtLeastMinVersion("v1.5.4"));
        assertTrue(TokenTrackerHandler.isAtLeastMinVersion("1.5.19"));
        assertTrue(TokenTrackerHandler.isAtLeastMinVersion("1.10.0"));
        assertTrue(TokenTrackerHandler.isAtLeastMinVersion("2.0.0"));
    }
}
