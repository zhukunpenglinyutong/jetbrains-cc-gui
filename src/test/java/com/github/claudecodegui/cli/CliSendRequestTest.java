package com.github.claudecodegui.cli;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class CliSendRequestTest {

    @Test
    public void preservesPermissionSessionIdForCliPermissionRouting() {
        CliSendRequest request = new CliSendRequest(
                "tab-1",
                "claude",
                "hello",
                null,
                null,
                List.of(),
                null,
                List.of(),
                null,
                "acceptEdits",
                "claude-sonnet-4-6",
                "high",
                "permission-session-123",
                Map.of()
        );

        assertEquals("permission-session-123", request.permissionSessionId());
    }

    @Test
    public void acceptsMissingPermissionSessionIdForNonPermissionCliRequests() {
        CliSendRequest request = new CliSendRequest(
                "tab-1",
                "codex",
                "hello",
                null,
                null,
                List.of(),
                null,
                List.of(),
                null,
                "default",
                "gpt-5.3-codex",
                "high",
                null,
                Map.of()
        );

        assertNull(request.permissionSessionId());
    }
}
