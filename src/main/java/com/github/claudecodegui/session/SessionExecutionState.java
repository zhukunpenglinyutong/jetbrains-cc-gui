package com.github.claudecodegui.session;

import java.time.Clock;
import java.lang.ref.WeakReference;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** Backend turn facts for observers. UI loading/history flags are deliberately independent. */
public final class SessionExecutionState {
    private static final int MAX_INTERACTIONS = 16;
    private final Clock clock;
    private final Map<String, Interaction> interactions = new LinkedHashMap<>();
    private final Map<String, WeakReference<CompletableFuture<?>>> interactionFutures = new LinkedHashMap<>();
    private WeakReference<CompletableFuture<?>> backendFuture = new WeakReference<>(null);
    private String bindingEpoch = UUID.randomUUID().toString();
    private Turn currentTurn;
    private Phase activity = Phase.IDLE;
    private Outcome outcome = Outcome.NONE;
    private String terminalEventId = "";
    private long startedAt;
    private long completedAt;
    private long revision;
    private boolean interactionOverflow;
    private boolean stopRequested;
    private boolean deferredFailure;

    public enum Phase {
        IDLE, QUEUED, RUNNING, THINKING, WAITING_USER, STOPPING, SUCCEEDED, FAILED, CANCELLED, UNKNOWN
    }

    public enum Outcome {
        NONE, SUCCEEDED, FAILED, CANCELLED
    }

    public enum WaitReason {
        NONE, QUESTION, PERMISSION, PLAN
    }

    /** Captured by one provider callback owner; comparisons use object identity. */
    public record Turn(String bindingEpoch, String turnId) { }

    /** Opaque IDE interaction identity, containing no question, tool input or dialog text. */
    public record Interaction(Turn turn, String id, WaitReason reason) { }

    public record Snapshot(String bindingEpoch, String turnId, Phase phase, WaitReason waitReason,
                           String pendingInteractionId, int pendingInteractionCount, Outcome outcome,
                           String terminalEventId, long startedAt, long completedAt, long revision) { }

    public SessionExecutionState() {
        this(Clock.systemUTC());
    }

    SessionExecutionState(Clock clock) {
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    public synchronized Turn beginTurn() {
        currentTurn = new Turn(bindingEpoch, UUID.randomUUID().toString());
        activity = Phase.RUNNING;
        outcome = Outcome.NONE;
        terminalEventId = "";
        startedAt = clock.millis();
        completedAt = 0;
        interactions.clear();
        interactionFutures.clear();
        backendFuture.clear();
        interactionOverflow = false;
        stopRequested = false;
        deferredFailure = false;
        revision++;
        return currentTurn;
    }

    /** Binding replacement retires callback authority, without claiming the old task succeeded. */
    public synchronized void rebind() {
        bindingEpoch = UUID.randomUUID().toString();
        currentTurn = null;
        activity = Phase.IDLE;
        outcome = Outcome.NONE;
        terminalEventId = "";
        startedAt = 0;
        completedAt = 0;
        interactions.clear();
        interactionFutures.clear();
        backendFuture.clear();
        interactionOverflow = false;
        stopRequested = false;
        deferredFailure = false;
        revision++;
    }

    public synchronized Turn currentTurn() {
        return currentTurn;
    }

    public synchronized boolean hasLiveTurn() {
        return isLive(currentTurn);
    }

    public synchronized boolean isCurrentBinding(String epoch) {
        return bindingEpoch.equals(epoch);
    }

    public synchronized boolean isStopRequested(Turn turn) {
        return isLive(turn) && stopRequested;
    }

    /** Observe an owned SDK/lifecycle future without retaining its provider or UI object graph. */
    public synchronized void bindBackendFuture(Turn turn, CompletableFuture<?> future) {
        Objects.requireNonNull(future, "future");
        if (isLive(turn)) {
            backendFuture = new WeakReference<>(future);
        }
    }

    /** A cached RUNNING flag alone is not evidence of a still-owned execution. */
    public synchronized boolean hasOwnedPendingWork() {
        if (!isLive(currentTurn)) {
            return false;
        }
        CompletableFuture<?> backend = backendFuture.get();
        if (backend != null && !backend.isDone()) {
            return true;
        }
        return interactionFutures.values().stream().anyMatch(reference -> {
            CompletableFuture<?> future = reference.get();
            return future != null && !future.isDone();
        });
    }

    /** The exact IDE future owns the wait, including local answers, timeouts and exceptional completion. */
    public synchronized Interaction bindInteraction(Turn turn, WaitReason reason, CompletableFuture<?> future) {
        Objects.requireNonNull(future, "future");
        if (!isLive(turn) || future.isDone()) {
            return null;
        }
        for (Map.Entry<String, WeakReference<CompletableFuture<?>>> entry : interactionFutures.entrySet()) {
            if (entry.getValue().get() == future) {
                return interactions.get(entry.getKey());
            }
        }
        Interaction interaction = beginInteraction(turn, reason);
        if (interaction != null) {
            interactionFutures.put(interaction.id(), new WeakReference<>(future));
            future.whenComplete((ignored, error) -> endInteraction(interaction));
        }
        return interaction;
    }

    public synchronized boolean activity(Turn turn, Phase phase) {
        Objects.requireNonNull(phase, "phase");
        if (phase != Phase.QUEUED && phase != Phase.RUNNING && phase != Phase.THINKING
                && phase != Phase.STOPPING && phase != Phase.UNKNOWN) {
            throw new IllegalArgumentException("Use an explicit interaction or outcome for this phase");
        }
        if (!isLive(turn) || activity == phase
                || stopRequested && phase != Phase.UNKNOWN && phase != Phase.STOPPING) {
            return false;
        }
        if (phase == Phase.STOPPING) {
            stopRequested = true;
        }
        activity = phase;
        revision++;
        return true;
    }

    public synchronized Interaction beginInteraction(Turn turn, WaitReason reason) {
        Objects.requireNonNull(reason, "reason");
        if (reason == WaitReason.NONE) {
            throw new IllegalArgumentException("An interaction requires a wait reason");
        }
        if (!isLive(turn)) {
            return null;
        }
        if (interactions.size() == MAX_INTERACTIONS) {
            if (!interactionOverflow) {
                interactionOverflow = true;
                revision++;
            }
            return null;
        }
        Interaction interaction = new Interaction(turn, UUID.randomUUID().toString(), reason);
        interactions.put(interaction.id(), interaction);
        revision++;
        return interaction;
    }

    public synchronized boolean endInteraction(Interaction interaction) {
        if (interaction == null || !isLive(interaction.turn())
                || interactions.get(interaction.id()) != interaction) {
            return false;
        }
        interactions.remove(interaction.id());
        interactionFutures.remove(interaction.id());
        revision++;
        return true;
    }

    /** First explicit terminal result wins; cleanup, stale callbacks and duplicate results cannot replace it. */
    public synchronized boolean finish(Turn turn, Outcome result) {
        return finish(turn, result, false);
    }

    /** A confirmed process exit can settle a stopped failure without a separate cancellation acknowledgement. */
    public synchronized boolean finish(Turn turn, Outcome result, boolean processExited) {
        Objects.requireNonNull(result, "result");
        if (result == Outcome.NONE) {
            throw new IllegalArgumentException("A terminal result is required");
        }
        if (!isLive(turn)) {
            return false;
        }
        // Transport errors during a stop remain provisional until cancellation or process termination is confirmed.
        if (stopRequested && result == Outcome.FAILED && !processExited) {
            if (!deferredFailure) {
                deferredFailure = true;
                activity = Phase.UNKNOWN;
                revision++;
            }
            return false;
        }
        outcome = result;
        activity = switch (result) {
            case SUCCEEDED -> Phase.SUCCEEDED;
            case FAILED -> Phase.FAILED;
            case CANCELLED -> Phase.CANCELLED;
            case NONE -> throw new IllegalArgumentException("A terminal result is required");
        };
        completedAt = clock.millis();
        terminalEventId = UUID.randomUUID().toString();
        interactions.clear();
        interactionFutures.clear();
        backendFuture.clear();
        interactionOverflow = false;
        stopRequested = false;
        deferredFailure = false;
        revision++;
        return true;
    }

    public synchronized void stopFailed(Turn turn) {
        if (!isLive(turn) || !stopRequested) {
            return;
        }
        stopRequested = false;
        if (deferredFailure) {
            finish(turn, Outcome.FAILED);
        } else {
            activity = Phase.UNKNOWN;
            revision++;
        }
    }

    /** Immutable, metadata-only view; reading it never creates work or changes task truth. */
    public synchronized Snapshot snapshot() {
        Interaction pending = interactions.isEmpty() ? null : interactions.values().iterator().next();
        Phase phase = activity;
        if (outcome == Outcome.NONE && activity != Phase.STOPPING) {
            if (interactionOverflow) {
                phase = Phase.UNKNOWN;
            } else if (pending != null) {
                phase = Phase.WAITING_USER;
            }
        }
        boolean waiting = phase == Phase.WAITING_USER;
        return new Snapshot(bindingEpoch, currentTurn == null ? "" : currentTurn.turnId(), phase,
                waiting ? pending.reason() : WaitReason.NONE, waiting ? pending.id() : "", waiting ? interactions.size() : 0,
                outcome, terminalEventId, startedAt, completedAt, revision);
    }

    private boolean isLive(Turn turn) {
        return turn != null && turn == currentTurn && outcome == Outcome.NONE;
    }
}
