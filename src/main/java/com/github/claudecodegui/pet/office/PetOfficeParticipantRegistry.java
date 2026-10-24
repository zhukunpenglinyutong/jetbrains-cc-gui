package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;

import java.io.IOException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;

/** Atomic current-connection authority. Heartbeats carry transport liveness, never source truth. */
final class PetOfficeParticipantRegistry {
    static final int MAX_PARTICIPANTS = 16;
    // Keep the current renderer's declared capacity; later capacity expansion needs its own load gate.
    static final int MAX_TOTAL_SOURCES = PetOfficeSessionRegistry.MAX_SOURCES;
    private static final long MAX_AGE = 9_007_199_254_740_991L;
    private final Clock clock;
    private final LongSupplier nanoTime;
    private final Map<String, Participant> participants = new LinkedHashMap<>();
    private String ownerInstanceId;
    private long revision;
    private long capacityRejectedAt;
    private boolean hasCapacityRejection;

    record Connection(String instanceId, String epoch, String ticket) { }
    record View(PetOfficeSessionRegistry.CompleteSnapshot snapshot, List<String> participants) { }
    record AssetRoute(Connection connection, PetOfficeEndpointStore.Endpoint endpoint) { }

    synchronized void assetEndpoint(Connection connection, PetOfficeEndpointStore.Endpoint endpoint) throws IOException {
        if (!connection.instanceId().equals(endpoint.ownerInstanceId())) {
            throw new IOException("OFFICE_ASSET_STALE");
        }
        current(connection).assetEndpoint = endpoint;
    }

    synchronized AssetRoute assetRoute(String instanceId) {
        prune();
        Participant participant = participants.get(instanceId);
        return participant != null && participant.connected && participant.fresh && participant.assetEndpoint != null
                ? new AssetRoute(participant.connection, participant.assetEndpoint) : null;
    }

    synchronized boolean assetCurrent(AssetRoute route) {
        AssetRoute current = assetRoute(route.connection().instanceId());
        return current != null && current.connection() == route.connection() && current.endpoint().equals(route.endpoint());
    }

    PetOfficeParticipantRegistry() {
        this(Clock.systemUTC(), System::nanoTime);
    }

    PetOfficeParticipantRegistry(Clock clock, LongSupplier nanoTime) {
        this.clock = clock;
        this.nanoTime = nanoTime;
    }

    synchronized void bindOwner(String owner) throws IOException {
        validateId(owner);
        if (ownerInstanceId != null && !ownerInstanceId.equals(owner)
                || !participants.containsKey(owner) && participants.size() >= MAX_PARTICIPANTS) {
            throw new IOException("OFFICE_PARTICIPANT_CAPACITY");
        }
        ownerInstanceId = owner;
    }

    synchronized Connection connect(String instanceId, String epoch) throws IOException {
        validateId(instanceId);
        validateId(epoch);
        prune();
        Participant old = participants.get(instanceId);
        if (old != null && old.connection.epoch().equals(epoch)) {
            throw new IOException("OFFICE_CONNECTION_STALE");
        }
        int occupied = participants.size() + (ownerInstanceId != null && !participants.containsKey(ownerInstanceId) && !instanceId.equals(ownerInstanceId) ? 1 : 0);
        if (old == null && occupied >= MAX_PARTICIPANTS) {
            rejectCapacity();
            throw new IOException("OFFICE_PARTICIPANT_CAPACITY");
        }
        Connection connection = new Connection(instanceId, epoch, UUID.randomUUID().toString());
        Participant participant = old == null ? new Participant() : old;
        participant.connection = connection;
        participant.assetEndpoint = null;
        participant.connected = true;
        participant.fresh = false;
        participant.lastSeen = nanoTime.getAsLong();
        participants.put(instanceId, participant);
        revision++;
        return connection;
    }

    synchronized void heartbeat(Connection connection) throws IOException {
        current(connection).lastSeen = nanoTime.getAsLong();
    }

    void commit(Connection connection, byte[] bytes, long transferAgeMillis) throws IOException {
        commit(connection, bytes, transferAgeMillis, -1);
    }

    void commit(Connection connection, byte[] bytes, long transferAgeMillis, long expectedWatermark) throws IOException {
        var snapshot = PetOfficeParticipantSnapshotCodec.decode(bytes, connection.instanceId(), connection.epoch());
        if (expectedWatermark >= 0 && snapshot.watermark() != expectedWatermark) {
            throw new IOException("OFFICE_SNAPSHOT_WATERMARK_INVALID");
        }
        synchronized (this) {
            Participant participant = current(connection);
            long now = nanoTime.getAsLong();
            if (transferAgeMillis < 0 || transferAgeMillis > 10_000) {
                throw new IOException("OFFICE_SNAPSHOT_EXPIRED");
            }
            if (participant.snapshot != null && (snapshot.watermark() < participant.snapshot.watermark()
                    || participant.fresh && snapshot.watermark() == participant.snapshot.watermark())) {
                throw new IOException("OFFICE_SNAPSHOT_STALE");
            }
            int total = snapshot.sources().size();
            for (Participant other : participants.values()) {
                if (other != participant && other.snapshot != null) {
                    total += other.snapshot.sources().size();
                }
            }
            if (total > MAX_TOTAL_SOURCES) {
                participant.rejected = true;
                rejectCapacity();
                throw new IOException("OFFICE_SOURCE_CAPACITY");
            }
            Map<String, PetOfficeSessionRegistry.SourceSnapshot> previous = new HashMap<>();
            if (participant.snapshot != null) {
                for (var source : participant.snapshot.sources()) {
                    previous.put(PetOfficeSessionRegistry.key(source.sourceKey()), source);
                }
            }
            List<PetOfficeSessionRegistry.SourceSnapshot> admitted = new ArrayList<>();
            for (var source : snapshot.sources()) {
                var old = previous.get(PetOfficeSessionRegistry.key(source.sourceKey()));
                long age = add(source.observationAgeMillis(), transferAgeMillis);
                long grace = Math.max(0, source.terminalGraceRemainingMillis() - transferAgeMillis);
                if (old != null) {
                    if (source.sourceRevision() < old.sourceRevision() || source.observationRevision() < old.observationRevision()
                            || source.execution().revision() < old.execution().revision()) {
                        throw new IOException("OFFICE_SOURCE_STALE");
                    }
                    if (source.observationRevision() == old.observationRevision()) {
                        age = Math.max(age, add(old.observationAgeMillis(), elapsed(now, participant.capturedAt)));
                    }
                    if (source.execution().terminalEventId().equals(old.execution().terminalEventId())) {
                        grace = Math.min(grace, Math.max(0, old.terminalGraceRemainingMillis() - elapsed(now, participant.capturedAt)));
                    }
                }
                admitted.add(copy(source, source.execution(), source.routeStatus(), age, grace));
            }
            participant.snapshot = new PetOfficeSessionRegistry.CompleteSnapshot(1, snapshot.instanceId(), snapshot.connectionEpoch(),
                    snapshot.watermark(), snapshot.sampledAt(), admitted, snapshot.recentResults(), snapshot.capacityReached());
            participant.capturedAt = now;
            participant.lastSeen = now;
            participant.fresh = true;
            participant.rejected = false;
            for (var result : snapshot.recentResults()) {
                participant.resultSeen.putIfAbsent(result.terminalEventId(), now);
            }
            participant.resultSeen.keySet().retainAll(snapshot.recentResults().stream().map(PetOfficeSessionRegistry.RecentResult::terminalEventId).toList());
            revision++;
        }
    }

    synchronized void disconnect(Connection connection) {
        Participant participant = participants.get(connection.instanceId());
        if (participant != null && participant.connection == connection) {
            if (participant.snapshot == null) {
                participants.remove(connection.instanceId());
            } else {
                participant.connected = false;
                participant.fresh = false;
                participant.lastSeen = nanoTime.getAsLong();
            }
            revision++;
        }
    }

    synchronized View view(String ownerInstanceId, String leaderEpoch) {
        prune();
        long now = nanoTime.getAsLong();
        List<PetOfficeSessionRegistry.SourceSnapshot> sources = new ArrayList<>();
        Map<String, PetOfficeSessionRegistry.RecentResult> recent = new LinkedHashMap<>();
        List<String> owners = new ArrayList<>(List.of(ownerInstanceId));
        boolean capacity = hasCapacityRejection && elapsed(now, capacityRejectedAt) < PetOfficeSessionRegistry.RETIRE_MILLIS;
        for (var entry : participants.entrySet()) {
            if (!owners.contains(entry.getKey())) {
                owners.add(entry.getKey());
            }
            Participant participant = entry.getValue();
            capacity |= participant.rejected;
            if (participant.snapshot == null) {
                continue;
            }
            capacity |= participant.snapshot.capacityReached();
            boolean connected = participant.connected && participant.fresh && elapsed(now, participant.lastSeen) < PetOfficeSessionRegistry.STALE_MILLIS;
            long deliveryAge = elapsed(now, participant.capturedAt);
            for (var source : participant.snapshot.sources()) {
                long age = add(source.observationAgeMillis(), deliveryAge);
                long grace = Math.max(0, source.terminalGraceRemainingMillis() - deliveryAge);
                var execution = source.execution();
                if (!connected || execution.outcome() == SessionExecutionState.Outcome.NONE && execution.phase() != SessionExecutionState.Phase.IDLE
                        && age >= PetOfficeSessionRegistry.STALE_MILLIS) {
                    execution = phase(execution, SessionExecutionState.Phase.UNKNOWN);
                } else if (execution.outcome() != SessionExecutionState.Outcome.NONE && grace == 0) {
                    execution = phase(execution, SessionExecutionState.Phase.IDLE);
                }
                sources.add(copy(source, execution, connected ? source.routeStatus() : PetOfficeSessionRegistry.RouteStatus.DETACHED, age, grace));
            }
            for (var result : participant.snapshot.recentResults()) {
                if (elapsed(now, participant.resultSeen.getOrDefault(result.terminalEventId(), now)) < PetOfficeSessionRegistry.RECENT_RETENTION_MILLIS) {
                    recent.putIfAbsent(result.terminalEventId(), result);
                }
            }
        }
        while (recent.size() > PetOfficeSessionRegistry.MAX_RECENT_RESULTS) {
            recent.remove(recent.keySet().iterator().next());
        }
        return new View(new PetOfficeSessionRegistry.CompleteSnapshot(1, ownerInstanceId, leaderEpoch, revision, clock.millis(),
                sources, List.copyOf(recent.values()), capacity), List.copyOf(owners));
    }

    synchronized Connection route(PetOfficeTabNavigator.Request request) throws IOException {
        prune();
        var key = PetOfficeSessionRegistry.parseKey(request.sourceKey());
        Participant participant = participants.get(key.instanceId());
        if (participant == null || !participant.connected || !participant.fresh || participant.snapshot == null) {
            return null;
        }
        return participant.snapshot.sources().stream().anyMatch(source -> source.sourceKey().equals(key)
                && source.routeStatus() == PetOfficeSessionRegistry.RouteStatus.AVAILABLE
                && source.routeGeneration().equals(request.routeGeneration())) ? participant.connection : null;
    }

    synchronized boolean routeCurrent(Connection connection, PetOfficeTabNavigator.Request request) {
        try {
            return route(request) == connection;
        } catch (IOException | RuntimeException invalid) {
            return false;
        }
    }

    private Participant current(Connection connection) throws IOException {
        prune();
        Participant participant = participants.get(connection.instanceId());
        if (participant == null || participant.connection != connection || !participant.connected) {
            throw new IOException("OFFICE_CONNECTION_STALE");
        }
        return participant;
    }

    private void rejectCapacity() {
        hasCapacityRejection = true;
        capacityRejectedAt = nanoTime.getAsLong();
        revision++;
    }

    private void prune() {
        long now = nanoTime.getAsLong();
        for (Participant participant : participants.values()) {
            if (participant.connected && elapsed(now, participant.lastSeen) >= PetOfficeSessionRegistry.STALE_MILLIS) {
                participant.connected = false;
                participant.fresh = false;
                revision++;
            }
        }
        if (participants.entrySet().removeIf(entry -> !entry.getValue().connected
                && elapsed(now, entry.getValue().lastSeen) >= PetOfficeSessionRegistry.RETIRE_MILLIS)) {
            revision++;
        }
    }

    private static void validateId(String value) throws IOException {
        if (value == null || !value.matches("[A-Za-z0-9._-]{1,128}") || value.equals(".") || value.equals("..")) {
            throw new IOException("OFFICE_IPC_ID_INVALID");
        }
    }

    private static long elapsed(long now, long then) {
        return Math.max(0, (now - then) / 1_000_000);
    }

    private static long add(long age, long additional) {
        return Math.min(MAX_AGE, age + additional);
    }

    private static SessionExecutionState.Snapshot phase(SessionExecutionState.Snapshot value, SessionExecutionState.Phase phase) {
        return new SessionExecutionState.Snapshot(value.bindingEpoch(), value.turnId(), phase, SessionExecutionState.WaitReason.NONE,
                "", 0, value.outcome(), value.terminalEventId(), value.startedAt(), value.completedAt(), value.revision());
    }

    private static PetOfficeSessionRegistry.SourceSnapshot copy(PetOfficeSessionRegistry.SourceSnapshot source,
                                                              SessionExecutionState.Snapshot execution, PetOfficeSessionRegistry.RouteStatus route,
                                                              long age, long grace) {
        return new PetOfficeSessionRegistry.SourceSnapshot(source.sourceKey(), source.sourceRevision(), source.metadata(), source.provider(), source.modelLabel(),
                execution, route, source.routeGeneration(), source.observationRevision(), age, grace);
    }

    private static final class Participant {
        private PetOfficeEndpointStore.Endpoint assetEndpoint;
        private Connection connection;
        private PetOfficeSessionRegistry.CompleteSnapshot snapshot;
        private boolean connected;
        private boolean fresh;
        private boolean rejected;
        private long capturedAt;
        private long lastSeen;
        private final Map<String, Long> resultSeen = new HashMap<>();
    }
}
