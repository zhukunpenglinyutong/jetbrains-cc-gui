package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClawBotSessionRegistryTest {

    @Test
    public void rejectsOldEpochAndRequiresMatchingHeartbeatOwner() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(registration("session", "ide-a", 2)));
        assertFalse(registry.register(registration("session", "ide-b", 1)));
        assertFalse(registry.heartbeat("session", "ide-b", 2, ClawBotSessionStatus.BUSY));
        assertTrue(registry.heartbeat("session", "ide-a", 2, ClawBotSessionStatus.BUSY));
        assertEquals(ClawBotSessionStatus.BUSY, registry.snapshot().get(0).status());
    }

    @Test
    public void marksOnlineSessionsStaleAfterHeartbeatLease() {
        MutableClock clock = new MutableClock();
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry(clock, Duration.ofSeconds(30));

        assertTrue(registry.register(registration("session", "ide-a", 1)));
        clock.advance(Duration.ofSeconds(30));

        assertEquals(1, registry.markStale());
        assertEquals(ClawBotSessionStatus.STALE, registry.snapshot().get(0).status());
        assertEquals(0, registry.markStale());
    }

    @Test
    public void unregisterRequiresCurrentOwnerAndReturnsImmutableSnapshot() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(registration("session", "ide-a", 1)));
        assertFalse(registry.unregister("session", "ide-b", 1));
        assertTrue(registry.unregister("session", "ide-a", 1));
        assertTrue(registry.snapshot().isEmpty());
    }

    @Test
    public void queuesInboundMessagesOnlyForCurrentInboundOwner() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        ClawBotSessionRegistration first = new ClawBotSessionRegistration(
                "session", "ide-a", "project", "Project", "codex",
                Set.of("STATUS", "INBOUND"), ClawBotSessionStatus.ONLINE, 1);
        assertTrue(registry.register(first));
        ClawBotInboundMessage message = new ClawBotInboundMessage(
                "message-1", "user-1", "context-1", "hello");
        assertTrue(registry.enqueueInbound("session", message));

        assertTrue(registry.register(new ClawBotSessionRegistration(
                "session", "ide-b", "project", "Project", "codex",
                Set.of("STATUS", "INBOUND"), ClawBotSessionStatus.ONLINE, 2)));
        assertEquals(null, registry.pollInbound("session", "ide-a", 1));
        assertEquals(null, registry.pollInbound("session", "ide-b", 2));
    }

    @Test
    public void keepsInboundUntilCurrentOwnerAcknowledgesIt() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(inboundRegistration()));
        ClawBotInboundMessage first = new ClawBotInboundMessage("first", "user", "context", "hello");
        ClawBotInboundMessage second = new ClawBotInboundMessage("second", "user", "context", "next");
        assertTrue(registry.enqueueInbound("session", first));
        assertTrue(registry.enqueueInbound("session", second));

        assertEquals(first, registry.pollInbound("session", "ide-a", 1));
        assertEquals(first, registry.pollInbound("session", "ide-a", 1));
        assertFalse(registry.acknowledgeInbound("session", "ide-b", 1, "first"));
        assertFalse(registry.acknowledgeInbound("session", "ide-a", 1, "second"));
        assertTrue(registry.acknowledgeInbound("session", "ide-a", 1, "first"));
        assertEquals(second, registry.pollInbound("session", "ide-a", 1));
    }

    @Test
    public void keepsDispatchedInboundAcrossRegistrationTargetRefresh() {
        assertDispatchedInboundSurvivesTargetRefresh(false);
    }

    @Test
    public void keepsDispatchedInboundAcrossSnapshotTargetRefresh() {
        assertDispatchedInboundSurvivesTargetRefresh(true);
    }

    @Test
    public void recordsExecutionClaimWithoutAllowingASecondClaim() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(inboundRegistration()));
        ClawBotInboundMessage inbound = new ClawBotInboundMessage(
                "inbound", "user", "context", "long task");
        assertTrue(registry.enqueueInbound("session", inbound));

        assertTrue(registry.markInboundDispatched("session", "ide-a", 1, "inbound"));
        assertTrue(registry.isInboundDispatched("session", "ide-a", 1, "inbound"));
        assertFalse(registry.isInboundDispatched("session", "ide-b", 1, "inbound"));
        assertTrue(registry.acknowledgeInbound("session", "ide-a", 1, "inbound"));
        assertFalse(registry.isInboundDispatched("session", "ide-a", 1, "inbound"));

        ClawBotSessionRegistration controlRegistration = new ClawBotSessionRegistration(
                "control", "ide-a", "project", "Project", "codex",
                Set.of("STATUS", "INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 1);
        assertTrue(registry.register(controlRegistration));
        ClawBotInboundMessage command = ClawBotInboundMessage.command(
                new ClawBotInboundMessage("command", "user", "context", "stop"),
                ClawBotInboundAction.INTERRUPT);
        assertTrue(registry.enqueueCommand("control", command));
        assertTrue(registry.markCommandDispatched("control", "ide-a", 1, "command"));
        assertTrue(registry.isCommandDispatched("control", "ide-a", 1, "command"));
        assertTrue(registry.acknowledgeCommand("control", "ide-a", 1, "command"));
        assertFalse(registry.isCommandDispatched("control", "ide-a", 1, "command"));
    }

    @Test
    public void keepsControlCommandsIndependentFromRunningInboundMessage() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        ClawBotSessionRegistration registration = new ClawBotSessionRegistration(
                "session", "ide-a", "project", "Project", "codex",
                Set.of("STATUS", "INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 1);
        assertTrue(registry.register(registration));
        ClawBotInboundMessage inbound = new ClawBotInboundMessage(
                "message", "user", "context", "long task");
        ClawBotInboundMessage command = ClawBotInboundMessage.command(
                new ClawBotInboundMessage("command", "user", "context", "stop"),
                ClawBotInboundAction.INTERRUPT);
        assertTrue(registry.enqueueInbound("session", inbound));
        assertTrue(registry.enqueueCommand("session", command));

        assertEquals(inbound, registry.pollInbound("session", "ide-a", 1));
        assertEquals(command, registry.pollCommand("session", "ide-a", 1));
        assertTrue(registry.acknowledgeCommand("session", "ide-a", 1, "command"));
        assertEquals(inbound, registry.pollInbound("session", "ide-a", 1));
    }

    @Test
    public void revokingSenderRemovesOnlyThatSendersQueuedMessages() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(inboundRegistration()));
        assertTrue(registry.enqueueInbound("session", new ClawBotInboundMessage(
                "first", "sender-1", "context-1", "first message")));
        ClawBotInboundMessage retained = new ClawBotInboundMessage(
                "retained", "sender-2", "context-2", "retained message");
        assertTrue(registry.enqueueInbound("session", retained));
        assertTrue(registry.enqueueInbound("session", new ClawBotInboundMessage(
                "last", "sender-1", "context-3", "last message")));

        registry.clearPendingMessagesFromSender("sender-1");

        assertEquals(retained, registry.pollInbound("session", "ide-a", 1));
        registry.clearPendingMessages();
        assertEquals(null, registry.pollInbound("session", "ide-a", 1));
    }

    @Test
    public void rejectsOverflowWithoutDroppingQueuedMessages() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(inboundRegistration()));
        for (int index = 0; index < 64; index++) {
            assertTrue(registry.enqueueInbound("session", new ClawBotInboundMessage(
                    "message-" + index, "user", "context", "text")));
        }
        assertFalse(registry.enqueueInbound("session", new ClawBotInboundMessage(
                "overflow", "user", "context", "text")));
        assertEquals("message-0", registry.pollInbound("session", "ide-a", 1).messageId());
        for (int index = 0; index < 64; index++) {
            assertTrue(registry.acknowledgeInbound("session", "ide-a", 1, "message-" + index));
        }
        assertEquals(null, registry.pollInbound("session", "ide-a", 1));
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsControlCharactersInDisplayMetadata() {
        new ClawBotSessionRegistration("session", "ide-a", "project", "bad\nname", "codex",
                Set.of("STATUS"), ClawBotSessionStatus.ONLINE, 1);
    }

    private static ClawBotSessionRegistration registration(String handle, String instance, long epoch) {
        return new ClawBotSessionRegistration(handle, instance, "project", "Project", "codex",
                Set.of("STATUS", "CONTINUE"), ClawBotSessionStatus.ONLINE, epoch);
    }

    private static ClawBotSessionRegistration inboundRegistration() {
        return new ClawBotSessionRegistration("session", "ide-a", "project", "Project", "codex",
                Set.of("STATUS", "INBOUND"), ClawBotSessionStatus.ONLINE, 1);
    }

    private static void assertDispatchedInboundSurvivesTargetRefresh(boolean replaceSnapshot) {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        ClawBotSessionRegistration originalRegistration = inboundRegistration("generation-1");
        assertTrue(registry.register(originalRegistration));
        ClawBotSessionSnapshot originalTarget = registry.snapshot().get(0);
        ClawBotInboundMessage dispatched = new ClawBotInboundMessage(
                "dispatched", "user", "context", "running task").forTarget(originalTarget);
        ClawBotInboundMessage waiting = new ClawBotInboundMessage(
                "waiting", "user", "context", "not yet accepted").forTarget(originalTarget);
        assertTrue(registry.enqueueInbound("session", dispatched));
        assertTrue(registry.enqueueInbound("session", waiting));
        assertTrue(registry.markInboundDispatched("session", "ide-a", 1, "dispatched"));

        ClawBotSessionRegistration refreshedRegistration = inboundRegistration("generation-2");
        if (replaceSnapshot) {
            assertTrue(registry.replaceSnapshot("ide-a", 1, List.of(refreshedRegistration)));
        } else {
            assertTrue(registry.register(refreshedRegistration));
        }

        assertEquals(dispatched, registry.pollInbound("session", "ide-a", 1));
        assertTrue(registry.isInboundDispatched("session", "ide-a", 1, "dispatched"));
        assertTrue(registry.acknowledgeInbound("session", "ide-a", 1, "dispatched"));
        assertEquals(null, registry.pollInbound("session", "ide-a", 1));
    }

    private static ClawBotSessionRegistration inboundRegistration(String generation) {
        return new ClawBotSessionRegistration("session", "ide-a", "project", "Project", "codex",
                Set.of("STATUS", "INBOUND"), ClawBotSessionStatus.ONLINE, 1, "Chat", generation);
    }

    private static final class MutableClock extends Clock {
        private Instant current = Instant.parse("2026-09-25T00:00:00Z");

        @Override
        public ZoneId getZone() {
            return ZoneId.of("UTC");
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return current;
        }

        private void advance(Duration duration) {
            current = current.plus(duration);
        }
    }
}
