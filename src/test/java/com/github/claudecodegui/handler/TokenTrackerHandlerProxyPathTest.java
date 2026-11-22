package com.github.claudecodegui.handler;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class TokenTrackerHandlerProxyPathTest {

    @Test
    public void allowsTheTokenTrackerFunctionsAndLocalAuth() {
        assertTrue(TokenTrackerHandler.isAllowedProxyPath("/functions/tokentracker-usage-summary"));
        assertTrue(TokenTrackerHandler.isAllowedProxyPath("/functions/tokentracker-usage-daily?from=2026-11-01&to=2026-11-14"));
        assertTrue(TokenTrackerHandler.isAllowedProxyPath("/api/local-auth"));
    }

    @Test
    public void rejectsTraversalOutOfTheAllowedPrefix() {
        assertFalse(TokenTrackerHandler.isAllowedProxyPath("/functions/tokentracker-../../api/proxy-config"));
        assertFalse(TokenTrackerHandler.isAllowedProxyPath("/functions/tokentracker-%2e%2e/%2E%2E/api/proxy-config"));
        assertFalse(TokenTrackerHandler.isAllowedProxyPath("/functions/tokentracker-x/..%2f..%2fapi"));
    }

    @Test
    public void rejectsOtherPaths() {
        assertFalse(TokenTrackerHandler.isAllowedProxyPath("/api/proxy-config"));
        assertFalse(TokenTrackerHandler.isAllowedProxyPath("/api/local-auth/extra"));
        assertFalse(TokenTrackerHandler.isAllowedProxyPath(""));
        assertFalse(TokenTrackerHandler.isAllowedProxyPath(null));
    }
}
