package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;
import com.github.claudecodegui.session.SessionState;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.LongSupplier;

/** Bounded local authority. Only backend facts and display metadata enter a complete snapshot. */
public final class PetOfficeSessionRegistry {
    static final int MAX_SOURCES = 256;
    static final int FLOOR_CAPACITY = 12;
    static final int MAX_FLOORS = (MAX_SOURCES + FLOOR_CAPACITY - 1) / FLOOR_CAPACITY;
    static final int MAX_RECENT_RESULTS = 50;
    static final long STALE_MILLIS = 15_000;
    static final long RETIRE_MILLIS = 30_000;
    static final long TERMINAL_GRACE_MILLIS = 5_000;
    static final long RECENT_RETENTION_MILLIS = 600_000;
    private final String instanceId;
    private final String connectionEpoch = UUID.randomUUID().toString();
    private final Clock clock;
    private final LongSupplier nanoTime;
    private final Map<String, Registration> registrations = new LinkedHashMap<>();
    private final Map<SourceKey, Entry> sources = new LinkedHashMap<>();
    private final Map<String, RetainedResult> recentResults = new LinkedHashMap<>();
    private long revision;
    private boolean capacityReached;

    public enum RouteStatus { AVAILABLE, DETACHED, CLOSED }

    public enum RouteValidation { AVAILABLE, TARGET_GONE, STALE_INTERACTION }

    public record SourceKey(String instanceId, String contentHandleId, String bindingEpoch) { }

    public static String key(SourceKey value) {
        return value.instanceId() + "/" + value.contentHandleId() + "/" + value.bindingEpoch();
    }

    public static SourceKey parseKey(String value) {
        if (value == null || value.length() > 386) {
            throw new IllegalArgumentException("Invalid source key");
        }
        String[] parts = value.split("/", -1);
        if (parts.length != 3) {
            throw new IllegalArgumentException("Invalid source key");
        }
        return new SourceKey(identifier(parts[0]), identifier(parts[1]), identifier(parts[2]));
    }

    /** Recheck real interaction ownership at activation time, rather than a five-second presentation cache. */
    public synchronized RouteValidation validateRoute(String sourceKey, String routeGeneration, String interactionId) {
        Entry entry = sources.get(parseKey(sourceKey));
        if (entry == null || entry.routeStatus != RouteStatus.AVAILABLE || !entry.routeGeneration.equals(routeGeneration)) {
            return RouteValidation.TARGET_GONE;
        }
        if (interactionId != null && !interactionId.isEmpty()
                && !entry.state.snapshot().pendingInteractionId().equals(interactionId)) {
            return RouteValidation.STALE_INTERACTION;
        }
        return RouteValidation.AVAILABLE;
    }

    public record Metadata(String contentHandleId, String productCode, String productName,
                           String projectId, String projectLabel, String tabLabel) {
        public Metadata {
            contentHandleId = identifier(contentHandleId);
            productCode = label(productCode);
            productName = label(productName);
            projectId = identifier(projectId);
            projectLabel = label(projectLabel);
            tabLabel = label(tabLabel);
        }
    }

    public record SourceSnapshot(SourceKey sourceKey, long sourceRevision, Metadata metadata, String provider,
                                 String modelLabel, SessionExecutionState.Snapshot execution, RouteStatus routeStatus,
                                 String routeGeneration, long observationRevision, long observationAgeMillis,
                                 long terminalGraceRemainingMillis) { }

    public record RecentResult(SourceKey sourceKey, Metadata metadata, String provider, String modelLabel,
                               String turnId, SessionExecutionState.Outcome outcome, String terminalEventId, long completedAt) { }

    public record CompleteSnapshot(int schemaVersion, String instanceId, String connectionEpoch, long watermark,
                                   long sampledAt, List<SourceSnapshot> sources, List<RecentResult> recentResults,
                                   boolean capacityReached) {
        public CompleteSnapshot {
            sources = List.copyOf(sources);
            recentResults = List.copyOf(recentResults);
        }
    }

    public PetOfficeSessionRegistry(String instanceId) {
        this(instanceId, Clock.systemUTC(), System::nanoTime);
    }

    PetOfficeSessionRegistry(String instanceId, Clock clock, LongSupplier nanoTime) {
        this.instanceId = identifier(instanceId);
        this.clock = Objects.requireNonNull(clock, "clock");
        this.nanoTime = Objects.requireNonNull(nanoTime, "nanoTime");
    }

    public Registration register(Metadata metadata, SessionState state) {
        Objects.requireNonNull(state, "state");
        Registration registration;
        synchronized (this) {
            if (registrations.containsKey(metadata.contentHandleId())) {
                throw new IllegalArgumentException("Content handle already registered");
            }
            if (registrations.size() >= MAX_SOURCES || sources.size() >= MAX_SOURCES) {
                markCapacityReached();
                return null;
            }
            registration = new Registration(metadata);
            registrations.put(metadata.contentHandleId(), registration);
        }
        registration.replaceSession(state);
        return registration;
    }

    /** The polling path checks owned futures; heartbeat and cached UI loading flags have no authority here. */
    public synchronized void observe() {
        long now = nanoTime.getAsLong();
        Iterator<Entry> iterator = sources.values().iterator();
        while (iterator.hasNext()) {
            Entry entry = iterator.next();
            entry.observe(now);
            if (entry.routeStatus != RouteStatus.AVAILABLE
                    && (entry.execution.turnId().isEmpty() || (entry.execution.outcome() != SessionExecutionState.Outcome.NONE
                    ? elapsed(now, entry.terminalObservedAt) >= TERMINAL_GRACE_MILLIS
                    : !entry.state.hasOwnedPendingWork() && elapsed(now, entry.lastProofAt) >= RETIRE_MILLIS))) {
                iterator.remove();
                revision++;
            }
        }
        if (recentResults.values().removeIf(result -> elapsed(now, result.observedAt) >= RECENT_RETENTION_MILLIS)) {
            revision++;
        }
    }

    /** Atomic source set at one watermark. Reading neither starts an AI nor renews an observation. */
    public synchronized CompleteSnapshot snapshot() {
        long now = nanoTime.getAsLong();
        List<SourceSnapshot> snapshots = new ArrayList<>(sources.size());
        for (Entry entry : sources.values()) {
            snapshots.add(entry.snapshot(now));
        }
        List<RecentResult> recent = recentResults.values().stream().map(value -> value.result).toList();
        return new CompleteSnapshot(1, instanceId, connectionEpoch, revision, clock.millis(), snapshots, recent, capacityReached);
    }

    public void close() {
        List<Registration> owners;
        synchronized (this) {
            owners = List.copyOf(registrations.values());
        }
        owners.forEach(Registration::close);
        synchronized (this) {
            sources.clear();
            recentResults.clear();
            revision++;
        }
    }

    private synchronized void bindingChanged(Registration registration, long generation, SessionState.ExecutionBinding binding) {
        if (registration.closed.get() || registration.subscriptionGeneration.get() != generation
                || registrations.get(registration.metadata.contentHandleId()) != registration) {
            return;
        }
        SourceKey key = new SourceKey(instanceId, registration.metadata.contentHandleId(), binding.execution().snapshot().bindingEpoch());
        if (!key.equals(registration.currentKey)) {
            Entry old = sources.get(registration.currentKey);
            if (old != null) {
                old.detach(RouteStatus.DETACHED);
                old.observe(nanoTime.getAsLong());
                if (old.execution.turnId().isEmpty()) {
                    sources.remove(registration.currentKey);
                }
            }
            registration.currentKey = key;
        }
        Entry entry = sources.get(key);
        if (entry == null) {
            if (sources.size() >= MAX_SOURCES) {
                markCapacityReached();
                return;
            }
            entry = new Entry(key, registration.metadata, binding);
            sources.put(key, entry);
            revision++;
        } else if (!entry.metadata.equals(registration.metadata) || !entry.provider.equals(label(binding.provider()))
                || !entry.modelLabel.equals(label(binding.model()))) {
            entry.metadata = registration.metadata;
            entry.provider = label(binding.provider());
            entry.modelLabel = label(binding.model());
            entry.sourceRevision++;
            revision++;
        }
        entry.observe(nanoTime.getAsLong());
    }

    private void markCapacityReached() {
        if (!capacityReached) {
            capacityReached = true;
            revision++;
        }
    }

    public final class Registration implements AutoCloseable {
        private final AtomicBoolean closed = new AtomicBoolean();
        private final AtomicLong subscriptionGeneration = new AtomicLong();
        private final AtomicReference<Runnable> unsubscribe = new AtomicReference<>();
        private Metadata metadata;
        private SourceKey currentKey;

        private Registration(Metadata metadata) {
            this.metadata = metadata;
        }

        public synchronized void replaceSession(SessionState state) {
            long generation = subscriptionGeneration.incrementAndGet();
            Runnable previous = unsubscribe.getAndSet(null);
            if (previous != null) {
                previous.run();
            }
            if (closed.get()) {
                return;
            }
            Runnable cleanup = state.observeExecutionBindings(binding -> bindingChanged(this, generation, binding));
            if (!unsubscribe.compareAndSet(null, cleanup) || closed.get() || subscriptionGeneration.get() != generation) {
                unsubscribe.compareAndSet(cleanup, null);
                cleanup.run();
            }
        }

        public void rename(String tabLabel) {
            synchronized (PetOfficeSessionRegistry.this) {
                if (closed.get()) {
                    return;
                }
                metadata = new Metadata(metadata.contentHandleId(), metadata.productCode(), metadata.productName(),
                        metadata.projectId(), metadata.projectLabel(), tabLabel);
                Entry current = sources.get(currentKey);
                if (current != null && !current.metadata.equals(metadata)) {
                    current.metadata = metadata;
                    current.sourceRevision++;
                    revision++;
                }
            }
        }

        @Override
        public synchronized void close() {
            if (!closed.compareAndSet(false, true)) {
                return;
            }
            Runnable cleanup = unsubscribe.getAndSet(null);
            if (cleanup != null) {
                cleanup.run();
            }
            synchronized (PetOfficeSessionRegistry.this) {
                registrations.remove(metadata.contentHandleId(), this);
                for (Entry entry : sources.values()) {
                    if (entry.key.contentHandleId().equals(metadata.contentHandleId())) {
                        entry.detach(RouteStatus.CLOSED);
                    }
                }
                // No cancellation is issued: the existing tab/backend teardown owns that policy.
                observe();
            }
        }
    }

    private final class Entry {
        private final SourceKey key;
        private final SessionExecutionState state;
        private Metadata metadata;
        private String provider;
        private String modelLabel;
        private SessionExecutionState.Snapshot execution;
        private RouteStatus routeStatus = RouteStatus.AVAILABLE;
        private String routeGeneration = UUID.randomUUID().toString();
        private long sourceRevision = 1;
        private long observationRevision;
        private long lastProofAt;
        private long terminalObservedAt;

        private Entry(SourceKey key, Metadata metadata, SessionState.ExecutionBinding binding) {
            this.key = key;
            this.metadata = metadata;
            this.provider = label(binding.provider());
            this.modelLabel = label(binding.model());
            this.state = binding.execution();
            this.lastProofAt = nanoTime.getAsLong();
        }

        private void detach(RouteStatus status) {
            if (routeStatus != status) {
                routeStatus = status;
                routeGeneration = UUID.randomUUID().toString();
                sourceRevision++;
                revision++;
            }
        }

        private void observe(long now) {
            SessionExecutionState.Snapshot next = state.snapshot();
            if (next.outcome() == SessionExecutionState.Outcome.NONE && next.phase() == SessionExecutionState.Phase.WAITING_USER
                    && !state.hasOwnedPendingWork()) {
                next = phase(next, SessionExecutionState.Phase.UNKNOWN);
            }
            if (!"claude".equals(provider) && !"codex".equals(provider) && !next.turnId().isEmpty()) {
                next = new SessionExecutionState.Snapshot(next.bindingEpoch(), next.turnId(), SessionExecutionState.Phase.UNKNOWN,
                        SessionExecutionState.WaitReason.NONE, "", 0, SessionExecutionState.Outcome.NONE, "",
                        next.startedAt(), 0, next.revision());
            }
            boolean changed = !next.equals(execution);
            if (changed) {
                execution = next;
                sourceRevision++;
                revision++;
                if (next.outcome() != SessionExecutionState.Outcome.NONE) {
                    terminalObservedAt = now;
                    String eventKey = key + "/" + next.turnId() + "/" + next.terminalEventId();
                    recentResults.putIfAbsent(eventKey, new RetainedResult(new RecentResult(key, metadata, provider, modelLabel,
                            next.turnId(), next.outcome(), next.terminalEventId(), next.completedAt()), now));
                    while (recentResults.size() > MAX_RECENT_RESULTS) {
                        recentResults.remove(recentResults.keySet().iterator().next());
                    }
                }
            }
            if (changed || next.turnId().isEmpty() || next.outcome() != SessionExecutionState.Outcome.NONE || state.hasOwnedPendingWork()) {
                observationRevision++;
                lastProofAt = now;
                revision++;
            }
        }

        private SourceSnapshot snapshot(long now) {
            long age = elapsed(now, lastProofAt);
            SessionExecutionState.Snapshot presented = execution;
            if (execution.outcome() == SessionExecutionState.Outcome.NONE && !execution.turnId().isEmpty() && age >= STALE_MILLIS) {
                presented = phase(execution, SessionExecutionState.Phase.UNKNOWN);
            } else if (execution.outcome() != SessionExecutionState.Outcome.NONE
                    && elapsed(now, terminalObservedAt) >= TERMINAL_GRACE_MILLIS) {
                presented = phase(execution, SessionExecutionState.Phase.IDLE);
            }
            return new SourceSnapshot(key, sourceRevision, metadata, provider, modelLabel, presented, routeStatus,
                    routeGeneration, observationRevision, age, execution.outcome() == SessionExecutionState.Outcome.NONE
                    ? 0 : Math.max(0, TERMINAL_GRACE_MILLIS - elapsed(now, terminalObservedAt)));
        }
    }

    private record RetainedResult(RecentResult result, long observedAt) { }

    private static SessionExecutionState.Snapshot phase(SessionExecutionState.Snapshot original, SessionExecutionState.Phase phase) {
        return new SessionExecutionState.Snapshot(original.bindingEpoch(), original.turnId(), phase, SessionExecutionState.WaitReason.NONE,
                "", 0, original.outcome(), original.terminalEventId(), original.startedAt(), original.completedAt(), original.revision());
    }

    private static long elapsed(long now, long then) {
        return Math.max(0, now - then) / 1_000_000;
    }

    private static String identifier(String value) {
        if (value == null || !value.matches("[A-Za-z0-9._-]{1,128}") || value.equals(".") || value.equals("..")) {
            throw new IllegalArgumentException("Invalid opaque identifier");
        }
        return value;
    }

    private static String label(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder result = new StringBuilder(160);
        value.codePoints().filter(code -> !Character.isISOControl(code) && Character.getType(code) != Character.FORMAT)
                .limit(160).forEach(result::appendCodePoint);
        return result.toString().trim();
    }
}
