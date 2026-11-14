package com.github.claudecodegui.session;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;

public class SessionCallbackAdapterIdentityTest {
    @Test
    public void restoredIdentityCarriesItsRequestWhileNativeIdentityRemainsCompatible() {
        List<List<String>> identities = new ArrayList<>();
        SessionCallbackAdapter adapter = new SessionCallbackAdapter(null, (name, args) -> {
            if (name.equals("setSessionId")) { identities.add(List.of(args)); }
        }, null, () -> true, null);
        try {
            ClaudeSession session = new ClaudeSession(null, null, null, null);
            session.setCallback(adapter);
            session.setSessionInfo("restored", "/fixture", "request-A");
            session.setSessionInfo("restored", "/fixture", "request-B");
            adapter.onSessionIdReceived("restored");
            adapter.onSessionIdReceived("native-new-id");
            assertEquals(List.of(List.of("restored", "request-A"), List.of("restored", "request-B"),
                    List.of("native-new-id")), identities);
            adapter.deactivate();
            session.setSessionInfo("late", "/fixture", "request-C");
            assertEquals(3, identities.size());
        } finally {
            adapter.dispose();
        }
    }
}
