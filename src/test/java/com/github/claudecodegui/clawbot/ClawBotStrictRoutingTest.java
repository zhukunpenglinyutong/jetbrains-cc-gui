package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

public class ClawBotStrictRoutingTest {

    @Test
    public void neverFallsBackAfterOffOrTargetDisappears() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.send("/use off");
        harness.sessions = List.of(target("second", "g1", 0));
        harness.send("hello");
        harness.send("stop current session");
        assertTrue(harness.delivered.isEmpty());
        harness.send("/use second");
        harness.sessions = List.of(target("third", "g1", 0));
        harness.send("hello again");
        harness.send("new session");
        assertTrue(harness.delivered.isEmpty());
    }

    @Test
    public void numbersReferToLastDisplayedListEvenWhenOrderChanges() throws Exception {
        Harness harness = new Harness();
        harness.send("/sessions");
        harness.sessions = List.of(target("second", "g1", 0), target("first", "g1", 0));
        harness.send("/use 1");
        harness.send("hello");
        assertEquals("first", harness.delivered.get(0).target().handle());
    }

    @Test
    public void numbersRequireFreshSenderSpecificListAndNeverShiftAfterRemoval() throws Exception {
        Harness harness = new Harness();
        harness.send("/use 1");
        assertTrue(harness.store.values.isEmpty());
        harness.send("/sessions");
        harness.sendAs("other", "/use 1");
        assertTrue(harness.store.values.isEmpty());
        harness.sessions = List.of(target("second", "g1", 0));
        harness.send("/use 1");
        assertTrue(harness.store.values.isEmpty());
        harness.send("/sessions");
        harness.time.set(TimeUnit.MINUTES.toNanos(5));
        harness.send("/use 1");
        assertTrue(harness.store.values.isEmpty());
    }

    @Test
    public void generationChangeInvalidatesSelectionAndOldNumber() throws Exception {
        Harness harness = new Harness();
        harness.send("/sessions");
        harness.send("/use 1");
        harness.sessions = List.of(target("first", "g2", 0));
        harness.send("/use 1");
        harness.send("hello");
        assertTrue(harness.delivered.isEmpty());
        assertTrue(harness.store.values.isEmpty());
    }

    @Test
    public void titleRenamePreservesSelectionButProviderAndOwnerChangesInvalidateIt() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        ClawBotSessionSnapshot original = harness.sessions.get(0);
        harness.sessions = List.of(new ClawBotSessionSnapshot(original.sessionHandleId(), original.instanceId(),
                original.projectId(), "Renamed project", original.provider(), original.capabilities(), original.status(),
                original.connectionEpoch(), 1, 1, "Renamed tab", original.generation(), 0));
        harness.send("hello");
        assertEquals(1, harness.delivered.size());
        harness.sessions = List.of(new ClawBotSessionSnapshot(original.sessionHandleId(), "other-ide",
                original.projectId(), "Project", "claude", original.capabilities(), original.status(),
                2, 1, 1, "Chat", original.generation(), 0));
        harness.send("not to replacement");
        assertEquals(1, harness.delivered.size());
    }

    @Test
    public void expiresAtThirtyIdleMinutesAndClearsPersistentLease() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(30)));
        harness.router.sweep(harness.sessions);
        assertTrue(harness.store.values.isEmpty());
        harness.send("hello");
        assertTrue(harness.delivered.isEmpty());
        assertTrue(harness.replies.get(harness.replies.size() - 1).contains("因空闲取消"));
    }

    @Test
    public void appliesUpdatedSessionIdleTimeoutWhenSweepingRoutes() throws Exception {
        Store store = new Store();
        AtomicLong time = new AtomicLong();
        AtomicReference<ClawBotProgressSettings> settings = new AtomicReference<>(
                new ClawBotProgressSettings(1, 5, 10, 15, 6, 800, 10));
        ClawBotMessageRouter router = new ClawBotMessageRouter(
                store, sender -> true, time::get, settings::get);
        List<ClawBotSessionSnapshot> sessions = List.of(target("first", "g1", 0));

        router.handle(new ClawBotInboundMessage("select", "user", "ctx", "/use first"), sessions,
                (sender, context, text) -> { }, (handle, message) -> true);
        router.sweep(List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(5))));
        assertFalse(store.values.isEmpty());

        settings.set(new ClawBotProgressSettings(1, 5, 10, 15, 6, 800, 5));
        router.sweep(List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(5))));
        assertTrue(store.values.isEmpty());
    }

    @Test
    public void invalidDuplicateAndUnauthorizedMessagesDoNotRenewLease() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(20)));
        harness.send("/unknown");
        harness.send("/use first extra");
        harness.sendAs("denied", "/status");
        harness.router.handle(new ClawBotInboundMessage("1", "user", "ctx", "/status"), harness.sessions,
                (sender, context, text) -> harness.replies.add(text), (handle, message) -> true);
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(30)));
        harness.send("hello");
        assertTrue(harness.delivered.isEmpty());
    }

    @Test
    public void acceptedInteractionRenewsIdleAllowanceButOneShotDoesNotChangeSelection() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(20)), target("second", "g1", 0));
        harness.send("hello");
        harness.send("/continue second single message");
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(49)));
        harness.send("still first");
        assertEquals(List.of("first", "second", "first"), harness.delivered.stream().map(message -> message.target().handle()).toList());
    }

    @Test
    public void unavailableOrFailedEnqueueDoesNotRefreshRoute() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(20)));
        harness.router.handle(new ClawBotInboundMessage("failure", "user", "ctx", "hello"), harness.sessions,
                (sender, context, text) -> { }, (handle, message) -> false);
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(30)));
        harness.send("hello");
        assertTrue(harness.delivered.isEmpty());
    }

    @Test
    public void persistedLegacyRoutesAreNotRestoredAndFollowersDoNotEraseThem() throws Exception {
        Store store = new Store();
        store.values.put("user", "first");
        ClawBotMessageRouter router = new ClawBotMessageRouter(store, sender -> true);
        assertEquals("first", store.values.get("user"));
        List<ClawBotInboundMessage> delivered = new ArrayList<>();
        router.handle(new ClawBotInboundMessage("new", "user", "ctx", "hello"), List.of(target("first", "g1", 0)),
                (sender, context, text) -> { }, (handle, message) -> delivered.add(message));
        assertTrue(delivered.isEmpty());
    }

    @Test
    public void oldClientsCannotReceiveStrictRoutes() throws Exception {
        Harness harness = new Harness();
        harness.sessions = List.of(new ClawBotSessionSnapshot("first", "ide", "project", "Project", "codex",
                Set.of("INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 1, 1, 1));
        harness.send("/use first");
        harness.send("hello");
        assertTrue(harness.delivered.isEmpty());
    }

    @Test
    public void persistenceFailureDuringExpiryStillRemovesInMemoryRoute() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.store.failSave = true;
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(30)));
        assertThrows(IOException.class, () -> harness.router.sweep(harness.sessions));
        assertThrows(IOException.class, () -> harness.send("blocked during persistence failure"));
        harness.store.failSave = false;
        harness.router.sweep(harness.sessions);
        assertTrue(harness.store.values.isEmpty());
        harness.send("hello");
        assertTrue(harness.delivered.isEmpty());
    }

    @Test
    public void activeTaskTimeIsExcludedButCachedBusyHeartbeatsAreNotProof() {
        AtomicLong ticker = new AtomicLong();
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry(Clock.systemUTC(), Duration.ofDays(1), ticker::get);
        registry.register(registration("g1"));
        ticker.set(TimeUnit.MINUTES.toNanos(20));
        registry.reportActivity("first", "ide", 1, "g1", "turn-1");
        for (int step = 0; step < 720; step++) {
            ticker.addAndGet(TimeUnit.SECONDS.toNanos(10));
            registry.reportActivity("first", "ide", 1, "g1", "turn-1");
        }
        registry.reportActivity("first", "ide", 1, "g1", "");
        assertEquals(TimeUnit.MINUTES.toMillis(20), registry.snapshot().get(0).idleMillis());
        ticker.addAndGet(TimeUnit.MINUTES.toNanos(10));
        registry.heartbeat("first", "ide", 1, ClawBotSessionStatus.BUSY);
        assertEquals(TimeUnit.MINUTES.toMillis(30), registry.snapshot().get(0).idleMillis());
    }

    @Test
    public void activityProofExpiresAndCannotBeRenewedByWrongGeneration() {
        AtomicLong ticker = new AtomicLong();
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry(Clock.systemUTC(), Duration.ofDays(1), ticker::get);
        registry.register(registration("g1"));
        assertTrue(registry.reportActivity("first", "ide", 1, "g1", "turn"));
        ticker.set(TimeUnit.MINUTES.toNanos(1));
        assertFalse(registry.reportActivity("first", "ide", 1, "g2", "turn"));
        assertEquals(45_000, registry.snapshot().get(0).idleMillis());
    }

    @Test
    public void queuedMessageIsFencedAcrossReplacementAndSerialization() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        registry.register(registration("g1"));
        ClawBotInboundMessage message = new ClawBotInboundMessage("message", "user", "context", "text")
                .forTarget(registry.snapshot().get(0));
        assertEquals(message, ClawBotInboundMessage.fromJson(message.toJson()));
        assertTrue(registry.enqueueInbound("first", message));
        registry.register(registration("g2"));
        assertNull(registry.pollInbound("first", "ide", 1));
        assertFalse(registry.enqueueInbound("first", message));
    }

    private static ClawBotSessionRegistration registration(String generation) {
        return new ClawBotSessionRegistration("first", "ide", "project", "Project", "codex",
                Set.of("INBOUND", "CONTROL", "ROUTING_V2"), ClawBotSessionStatus.ONLINE, 1, "Chat", generation);
    }

    @Test
    public void queuedRouteRemainsValidOnRenewalButNotAfterSwitchOffOrRevoke() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.send("first message");
        ClawBotInboundMessage pending = harness.delivered.get(0);
        assertTrue(harness.router.acceptsPending(pending));
        harness.send("/status");
        assertTrue(harness.router.acceptsPending(pending));
        harness.send("/use first");
        assertFalse(harness.router.acceptsPending(pending));
        harness.send("second message");
        pending = harness.delivered.get(1);
        harness.send("/use off");
        assertFalse(harness.router.acceptsPending(pending));
        ClawBotInboundMessage denied = new ClawBotInboundMessage("denied", "denied", "ctx", "text").forTarget(harness.sessions.get(0));
        assertFalse(harness.router.acceptsPending(denied));
        harness.send("/continue first single");
        assertTrue(harness.router.acceptsPending(harness.delivered.get(2)));
    }

    @Test
    public void queuedRouteExpiresBeforeDispatch() throws Exception {
        Harness harness = new Harness();
        harness.send("/use first");
        harness.send("queued");
        harness.sessions = List.of(target("first", "g1", TimeUnit.MINUTES.toMillis(30)));
        harness.router.sweep(harness.sessions);
        assertFalse(harness.router.acceptsPending(harness.delivered.get(0)));
    }

    @Test
    public void selectionPreviewUsesRouteRevisionAndDoesNotEnqueueProviderWork() throws Exception {
        Harness harness = new Harness();
        ClawBotPreviewMailbox previews = new ClawBotPreviewMailbox(harness.time::get);
        harness.router.setPreviewRequester(previews::request);
        harness.send("/use first");
        ClawBotInboundMessage preview = previews.poll("first", "ide", 1);
        assertNotNull(preview);
        assertTrue(harness.delivered.isEmpty());
        assertTrue(harness.router.acceptsPending(preview));
        harness.send("/use second");
        previews.sweep(harness.router::acceptsPending);
        assertNull(previews.poll("first", "ide", 1));
        assertNotNull(previews.poll("second", "ide", 1));
        harness.send("/use off");
        previews.sweep(harness.router::acceptsPending);
        assertNull(previews.poll("second", "ide", 1));
        assertTrue(harness.delivered.isEmpty());
    }

    @Test
    public void idleClockPreservesFractionsAndRejectsBackwardTime() {
        ClawBotSessionIdleClock clock = new ClawBotSessionIdleClock(0);
        assertEquals(0, clock.observe(500_000));
        assertEquals(1, clock.observe(1_000_000));
        assertEquals(Long.MAX_VALUE, clock.observe(0));
        assertEquals(Long.MAX_VALUE, clock.observe(2_000_000));
    }

    @Test
    public void failedSnapshotReplacementDoesNotDiscardAcceptedMessages() {
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry();
        registry.register(registration("g1"));
        ClawBotInboundMessage message = new ClawBotInboundMessage("message", "user", "context", "text")
                .forTarget(registry.snapshot().get(0));
        registry.enqueueInbound("first", message);
        ClawBotSessionRegistration invalid = new ClawBotSessionRegistration("second", "wrong-owner", "project", "Project", "codex",
                Set.of("INBOUND"), ClawBotSessionStatus.ONLINE, 1);
        assertFalse(registry.replaceSnapshot("ide", 1, List.of(registration("g2"), invalid)));
        assertEquals(message, registry.pollInbound("first", "ide", 1));
    }

    @Test
    public void twoHourActiveTaskPreservesOnlyRemainingIdleAllowance() throws Exception {
        Harness harness = new Harness();
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry(Clock.systemUTC(), Duration.ofDays(1), harness.time::get);
        registry.register(registration("g1"));
        harness.sessions = registry.snapshot();
        harness.send("/use first");
        harness.time.set(TimeUnit.MINUTES.toNanos(20));
        registry.reportActivity("first", "ide", 1, "g1", "active-turn");
        for (int step = 0; step < 720; step++) {
            harness.time.addAndGet(TimeUnit.SECONDS.toNanos(10));
            registry.reportActivity("first", "ide", 1, "g1", "active-turn");
            harness.router.sweep(registry.snapshot());
        }
        assertFalse(harness.store.values.isEmpty());
        registry.reportActivity("first", "ide", 1, "g1", "");
        harness.time.addAndGet(TimeUnit.MINUTES.toNanos(10));
        harness.sessions = registry.snapshot();
        harness.send("must reselect");
        assertTrue(harness.store.values.isEmpty());
        assertTrue(harness.delivered.isEmpty());
    }

    @Test
    public void staleBusyOwnerCannotReviveOldSelectionWithCachedHeartbeat() throws Exception {
        Harness harness = new Harness();
        ClawBotSessionRegistry registry = new ClawBotSessionRegistry(Clock.systemUTC(), Duration.ofSeconds(30), harness.time::get);
        registry.register(registration("g1"));
        harness.sessions = registry.snapshot();
        harness.send("/use first");
        registry.reportActivity("first", "ide", 1, "g1", "turn");
        harness.time.set(TimeUnit.SECONDS.toNanos(31));
        assertFalse(registry.heartbeat("first", "ide", 1, ClawBotSessionStatus.BUSY));
        harness.router.sweep(registry.snapshot());
        registry.register(registration("g1"));
        harness.sessions = registry.snapshot();
        harness.send("not revived");
        assertTrue(harness.delivered.isEmpty());
    }

    private static ClawBotSessionSnapshot target(String handle, String generation, long idleMillis) {
        return new ClawBotSessionSnapshot(handle, "ide", "project", "Project", "codex",
                Set.of("INBOUND", "CONTROL", "ROUTING_V2"), ClawBotSessionStatus.ONLINE, 1, 1, 1, "Chat", generation, idleMillis);
    }

    private static final class Harness {
        private final AtomicLong time = new AtomicLong();
        private final Store store = new Store();
        private final ClawBotMessageRouter router = new ClawBotMessageRouter(store, sender -> !sender.equals("denied"), time::get);
        private List<ClawBotSessionSnapshot> sessions = List.of(target("first", "g1", 0), target("second", "g1", 0));
        private final List<ClawBotInboundMessage> delivered = new ArrayList<>();
        private final List<String> replies = new ArrayList<>();
        private int sequence;

        private void send(String text) throws IOException {
            sendAs("user", text);
        }

        private void sendAs(String sender, String text) throws IOException {
            router.handle(new ClawBotInboundMessage(Integer.toString(++sequence), sender, "ctx", text), sessions,
                    (user, context, reply) -> replies.add(reply), (handle, message) -> delivered.add(message));
        }
    }

    private static final class Store implements ClawBotMessageRouter.RouteStore {
        private Map<String, String> values = new LinkedHashMap<>();
        private boolean failSave;

        @Override
        public Map<String, String> load() {
            return values;
        }

        @Override
        public void save(Map<String, String> routes) throws IOException {
            if (failSave) {
                throw new IOException("unavailable");
            }
            values = new LinkedHashMap<>(routes);
        }

        @Override
        public void clear() {
            values.clear();
        }
    }
}
