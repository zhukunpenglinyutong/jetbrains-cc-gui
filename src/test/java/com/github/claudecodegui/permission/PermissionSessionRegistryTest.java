package com.github.claudecodegui.permission;

import org.junit.Test;

import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PermissionSessionRegistryTest {

    @Test
    public void openChatIsNotReapedAfterADayWithoutAQuestion() {
        long dayAndAnHour = TimeUnit.HOURS.toMillis(25);
        assertFalse(PermissionSessionRegistry.shouldReapIdleSession(true, dayAndAnHour));
    }

    @Test
    public void abandonedSessionWithoutADialogIsReapedAfterADay() {
        long dayAndAnHour = TimeUnit.HOURS.toMillis(25);
        assertTrue(PermissionSessionRegistry.shouldReapIdleSession(false, dayAndAnHour));
    }

    @Test
    public void sessionAtTheIdleLimitIsKept() {
        assertFalse(PermissionSessionRegistry.shouldReapIdleSession(false, TimeUnit.HOURS.toMillis(24)));
    }
}
