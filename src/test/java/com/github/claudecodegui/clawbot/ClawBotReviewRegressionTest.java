package com.github.claudecodegui.clawbot;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.*;

/** Regressions for the reviewed gateway contract and its consumer boundaries. */
public class ClawBotReviewRegressionTest {
    @Test
    public void longMessageIdsCanBeAcknowledgedOnBothQueues() {
        var registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(reg("session", "ide", 1, ClawBotSessionStatus.ONLINE, "g")));
        String id = "m".repeat(ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH);
        assertTrue(registry.enqueueInbound("session", message(id)));
        assertTrue(registry.markInboundDispatched("session", "ide", 1, id));
        assertTrue(registry.acknowledgeInbound("session", "ide", 1, id));
        // IDs are session-wide: use a different one for the independent command.
        var command = new ClawBotInboundMessage("c".repeat(512), "user", "context", "stop", ClawBotInboundAction.INTERRUPT,
                ClawBotSessionTarget.of(registry.snapshot().get(0)), 0);
        assertTrue(registry.enqueueCommand("session", command));
        assertTrue(registry.markCommandDispatched("session", "ide", 1, command.messageId()));
        assertTrue(registry.acknowledgeCommand("session", "ide", 1, command.messageId()));
    }

    @Test
    public void queuesEnforceActionAndInteractionCapabilities() {
        var registry = new ClawBotSessionRegistry();
        assertTrue(registry.register(reg("session", "ide", 1, ClawBotSessionStatus.ONLINE, "g")));
        var target = registry.snapshot().get(0);
        for (ClawBotInboundAction action : List.of(ClawBotInboundAction.APPROVE, ClawBotInboundAction.DENY, ClawBotInboundAction.ANSWER)) {
            var unsafe = new ClawBotInboundMessage(action.name(), "user", "context", "answer", action, ClawBotSessionTarget.of(target), 1);
            assertFalse(registry.enqueueInbound("session", unsafe));
            assertFalse(registry.enqueueCommand("session", unsafe));
            var bound = new ClawBotInboundMessage(action.name(), "user", "context", "answer", action,
                    ClawBotSessionTarget.of(target), 1, "interaction-token");
            assertTrue(registry.enqueueCommand("session", bound));
            assertTrue(registry.acknowledgeCommand("session", "ide", 1, bound.messageId()));
        }
        assertFalse(registry.enqueueCommand("session", message("ordinary")));
        assertFalse(registry.enqueueInbound("session", ClawBotInboundMessage.command(message("stop"), ClawBotInboundAction.INTERRUPT)));
        var noControl = new ClawBotSessionRegistration("inbound", "ide", "project", "Project", "codex",
                Set.of("INBOUND"), ClawBotSessionStatus.ONLINE, 1, "Chat", "g");
        assertTrue(registry.register(noControl));
        assertFalse(registry.enqueueCommand("inbound", message("blocked").forInteraction("token")));
    }

    @Test
    public void commandsRetainTheirExactTargetRevisionAndInteractionToken() {
        var registry = new ClawBotSessionRegistry();
        registry.register(reg("session", "ide", 1, ClawBotSessionStatus.ONLINE, "g1"));
        var source = message("approval").forTarget(registry.snapshot().get(0)).forRoute(7).forInteraction("prompt-token");
        var command = ClawBotInboundMessage.command(source, ClawBotInboundAction.APPROVE);
        assertEquals(source.target(), command.target());
        assertEquals(7, command.routeRevision());
        assertEquals("prompt-token", command.interactionToken());
        assertTrue(registry.enqueueCommand("session", command));
        registry.register(reg("session", "ide", 1, ClawBotSessionStatus.ONLINE, "g2"));
        assertNull(registry.pollCommand("session", "ide", 1));
    }

    @Test
    public void aFailedContinuationDoesNotSwallowLaterAnswers() {
        var lifecycle = new ClawBotTurnLifecycle();
        lifecycle.bind(CompletableFuture.failedFuture(new IllegalStateException("interrupted original")));
        AtomicInteger dispatched = new AtomicInteger();
        for (int i = 0; i < 2; i++) {
            JsonObject response = lifecycle.respond(ClawBotReviewRegressionTest::answer, () -> "thread", () -> true,
                    text -> dispatched.incrementAndGet() == 1
                            ? CompletableFuture.failedFuture(new IllegalStateException("first follow-up failed"))
                            : CompletableFuture.completedFuture(null), Runnable::run);
            assertFalse(response.has("followUp"));
        }
        assertEquals(2, dispatched.get());
        assertFalse(lifecycle.failed());
        assertTrue(lifecycle.finishIfReady(false));
    }

    @Test
    public void unboundLifecycleReportsAnErrorAndKeepsTheFollowUp() {
        var lifecycle = new ClawBotTurnLifecycle();
        JsonObject response = lifecycle.respond(ClawBotReviewRegressionTest::answer, () -> "thread", () -> true,
                text -> { throw new AssertionError("Unbound lifecycle must not dispatch"); }, Runnable::run);
        assertTrue(response.has("error"));
        assertTrue(response.has("followUp"));
    }

    @Test
    public void unknownAndUnauthorizedSessionsExpireAndSnapshotCanReclaimTheirCapacity() {
        AtomicLong tick = new AtomicLong(1);
        var registry = new ClawBotSessionRegistry(Clock.systemUTC(), Duration.ofSeconds(30), tick::get);
        for (int i = 0; i < 256; i++) {
            assertTrue(registry.register(reg("old-" + i, "old", 1,
                    i % 2 == 0 ? ClawBotSessionStatus.UNKNOWN : ClawBotSessionStatus.UNAUTHORIZED, "g")));
        }
        tick.addAndGet(TimeUnit.SECONDS.toNanos(31));
        assertTrue(registry.replaceSnapshot("new", 1, List.of(reg("new", "new", 1, ClawBotSessionStatus.ONLINE, "g"))));
        assertTrue(registry.snapshot().stream().anyMatch(s -> s.sessionHandleId().equals("new")));
        assertEquals(256, registry.snapshot().size());
    }

    @Test
    public void foreignEpochCannotTakeAnExistingHandle() {
        var registry = new ClawBotSessionRegistry();
        registry.register(reg("session", "owner", 1, ClawBotSessionStatus.ONLINE, "g"));
        var impostor = reg("session", "foreign", Long.MAX_VALUE, ClawBotSessionStatus.ONLINE, "g");
        assertFalse(registry.register(impostor));
        assertFalse(registry.replaceSnapshot("foreign", Long.MAX_VALUE, List.of(impostor)));
        assertTrue(registry.heartbeat("session", "owner", 1, ClawBotSessionStatus.ONLINE));
        assertTrue(registry.register(reg("session", "owner", 2, ClawBotSessionStatus.ONLINE, "g2")));
    }

    @Test
    public void redeliveryIsIdempotentAcrossPendingAndAcknowledgedMessages() {
        var registry = new ClawBotSessionRegistry();
        registry.register(reg("session", "ide", 1, ClawBotSessionStatus.ONLINE, "g"));
        var message = message("redelivered");
        assertTrue(registry.enqueueInbound("session", message));
        assertTrue(registry.enqueueInbound("session", message));
        assertTrue(registry.acknowledgeInbound("session", "ide", 1, message.messageId()));
        assertNull(registry.pollInbound("session", "ide", 1));
        assertTrue(registry.enqueueInbound("session", message));
        assertNull(registry.pollInbound("session", "ide", 1));
    }

    @Test
    public void accumulatedIdleTimePausesDuringActivityAndRepeatedIdleReportsCannotResetIt() {
        AtomicLong tick = new AtomicLong(1);
        var registry = new ClawBotSessionRegistry(Clock.systemUTC(), Duration.ofHours(1), tick::get);
        registry.register(reg("session", "ide", 1, ClawBotSessionStatus.ONLINE, "g"));
        tick.addAndGet(TimeUnit.MINUTES.toNanos(10));
        assertEquals(600_000, registry.snapshot().get(0).idleMillis());
        registry.reportActivity("session", "ide", 1, "g", "turn");
        tick.addAndGet(TimeUnit.SECONDS.toNanos(5));
        registry.reportActivity("session", "ide", 1, "g", "");
        tick.addAndGet(TimeUnit.SECONDS.toNanos(3));
        assertEquals(603_000, registry.snapshot().get(0).idleMillis());
        registry.reportActivity("session", "ide", 1, "g", "");
        tick.addAndGet(TimeUnit.SECONDS.toNanos(2));
        assertEquals(605_000, registry.snapshot().get(0).idleMillis());
    }

    @Test
    public void idleObservationRequiresFreshActivityAndRejectsBackwardMonotonicTime() {
        var idle = new ClawBotSessionIdleClock(0);
        idle.report(true, 0);
        assertEquals(0, idle.observe(TimeUnit.SECONDS.toNanos(15)));
        assertEquals(5_000, idle.observe(TimeUnit.SECONDS.toNanos(20)));
        assertEquals(Long.MAX_VALUE, idle.observe(TimeUnit.SECONDS.toNanos(19)));
        assertEquals(Long.MAX_VALUE, idle.observe(TimeUnit.SECONDS.toNanos(21)));
    }

    @Test
    public void malformedRegistrationMetadataUsesTheDeclaredIOException() {
        var json = ClawBotSessionWireCodec.registrationToJson(reg("session", "ide", 1, ClawBotSessionStatus.ONLINE, "g"));
        json.addProperty("projectDisplayName", "x".repeat(129));
        assertThrows(IOException.class, () -> ClawBotSessionWireCodec.registrationFromJson(json));
        assertThrows(IOException.class, () -> ClawBotSessionWireCodec.registrationFromJson(null));
    }

    @Test
    public void nullTargetsAndActivityIdsAreRejectedAsInvalidArguments() {
        assertThrows(IllegalArgumentException.class, () -> new ClawBotSessionTarget(null, "ide", 1, "codex", "g"));
        var registry = new ClawBotSessionRegistry();
        assertThrows(IllegalArgumentException.class, () -> registry.reportActivity("session", "ide", 1, "g", null));
    }

    @Test
    public void optionalTargetAndRevisionRoundTripAndC1ControlsAreRejected() {
        var source = message("revision").forRoute(8);
        assertEquals(8, ClawBotInboundMessage.fromJson(source.toJson()).routeRevision());
        JsonObject json = source.toJson();
        json.add("target", com.google.gson.JsonNull.INSTANCE);
        assertNull(ClawBotInboundMessage.fromJson(json).target());
        assertThrows(IllegalArgumentException.class, () -> new ClawBotInboundMessage("id", "user", "context", "text\u0085"));
    }

    @Test
    public void malformedFollowUpShapesNeverDispatchOrThrow() {
        var lifecycle = new ClawBotTurnLifecycle();
        lifecycle.bind(CompletableFuture.completedFuture(null));
        for (String invalid : List.of("null", "{}", "1", "true")) {
            JsonObject result = answer();
            result.getAsJsonObject("followUp").add("threadId", JsonParser.parseString(invalid));
            JsonObject response = lifecycle.respond(() -> result, () -> "thread", () -> true,
                    text -> { throw new AssertionError("Invalid follow-up must not dispatch"); }, Runnable::run);
            assertTrue(response.has("error"));
        }
    }

    private static JsonObject answer() {
        return JsonParser.parseString("{\"replied\":true,\"followUp\":{\"threadId\":\"thread\",\"text\":\"Answer\"}}").getAsJsonObject();
    }

    private static ClawBotInboundMessage message(String id) {
        return new ClawBotInboundMessage(id, "user", "context", "text");
    }

    private static ClawBotSessionRegistration reg(String handle, String owner, long epoch, ClawBotSessionStatus status, String generation) {
        return new ClawBotSessionRegistration(handle, owner, "project", "Project", "codex", Set.of("INBOUND", "CONTROL"), status, epoch, "Chat", generation);
    }
}
