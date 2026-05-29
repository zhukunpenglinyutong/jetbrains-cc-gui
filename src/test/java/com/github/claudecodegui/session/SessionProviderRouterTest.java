package com.github.claudecodegui.session;

import org.junit.Test;

public class SessionProviderRouterTest {

    @Test(expected = IllegalArgumentException.class)
    public void launchChannelRejectsUnsupportedProvider() {
        SessionProviderRouter router = new SessionProviderRouter(null, null, null);

        router.launchChannel("unknown-provider", "channel-1", "session-1", "/workspace");
    }

    @Test(expected = IllegalStateException.class)
    public void launchChannelRequiresConfiguredOpenCodeBridge() {
        SessionProviderRouter router = new SessionProviderRouter(null, null, null);

        router.launchChannel("opencode", "channel-1", "session-1", "/workspace");
    }

    @Test(expected = IllegalStateException.class)
    public void interruptChannelRequiresConfiguredOpenCodeBridge() {
        SessionProviderRouter router = new SessionProviderRouter(null, null, null);

        router.interruptChannel("opencode", "channel-1");
    }

    @Test(expected = IllegalStateException.class)
    public void getSessionMessagesRequiresConfiguredOpenCodeBridge() {
        SessionProviderRouter router = new SessionProviderRouter(null, null, null);

        router.getSessionMessages("opencode", "session-1", "/workspace");
    }
}
