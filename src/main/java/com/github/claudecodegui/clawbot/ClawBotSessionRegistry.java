package com.github.claudecodegui.clawbot;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.LongSupplier;
import java.util.concurrent.TimeUnit;

/** Stores sanitized session metadata owned by the Claw Bot gateway leader. */
public final class ClawBotSessionRegistry {

    private static final Duration DEFAULT_STALE_AFTER = Duration.ofSeconds(30);
    private static final int MAX_PENDING_MESSAGES_PER_SESSION = 64;

    private final Clock clock;
    private final long staleAfterMillis;
    private final Map<String, ClawBotSessionSnapshot> sessions = new HashMap<>();
    private final Map<String, Deque<ClawBotInboundMessage>> pendingMessages = new HashMap<>();
    private final Map<String, Deque<ClawBotInboundMessage>> pendingCommands = new HashMap<>();
    private final Map<String, Set<String>> dispatchedMessages = new HashMap<>();
    private final Map<String, Set<String>> dispatchedCommands = new HashMap<>();
    private final Map<String, ClawBotSessionIdleClock> idleClocks = new HashMap<>();
    private final Map<String, Long> heartbeatTicks = new HashMap<>();
    private final LongSupplier ticker;

    /** Creates a registry with a thirty-second heartbeat lease. */
    public ClawBotSessionRegistry() {
        this(Clock.systemUTC(), DEFAULT_STALE_AFTER, System::nanoTime);
    }

    ClawBotSessionRegistry(Clock clock, Duration staleAfter) {
        this(clock, staleAfter, () -> TimeUnit.MILLISECONDS.toNanos(clock.millis()));
    }

    ClawBotSessionRegistry(Clock clock, Duration staleAfter, LongSupplier ticker) {
        this.clock = Objects.requireNonNull(clock, "clock");
        this.ticker = Objects.requireNonNull(ticker, "ticker");
        this.staleAfterMillis = Objects.requireNonNull(staleAfter, "staleAfter").toMillis();
        if (staleAfterMillis <= 0) {
            throw new IllegalArgumentException("staleAfter must be positive");
        }
    }

    /** Registers a session unless an older or equal connection epoch owns it. */
    public synchronized boolean register(ClawBotSessionRegistration registration) {
        Objects.requireNonNull(registration, "registration");
        ClawBotSessionSnapshot current = sessions.get(registration.sessionHandleId());
        if (current != null && !isNewer(registration, current)) {
            return false;
        }
        long now = clock.millis();
        ClawBotSessionSnapshot updated = new ClawBotSessionSnapshot(
                registration.sessionHandleId(), registration.instanceId(), registration.projectId(),
                registration.projectDisplayName(), registration.provider(), registration.capabilities(),
                registration.status(), registration.connectionEpoch(), now, now,
                registration.tabDisplayName(), registration.generation(), 0);
        if (current != null && !sameTarget(registration, current)) {
            String handle = registration.sessionHandleId();
            if (sameOwner(registration, current)) {
                pruneStaleUndispatched(pendingMessages.get(handle), dispatchedMessages.get(handle), updated);
                pruneStaleUndispatched(pendingCommands.get(handle), dispatchedCommands.get(handle), updated);
            } else {
                pendingMessages.remove(handle);
                pendingCommands.remove(handle);
                dispatchedMessages.remove(handle);
                dispatchedCommands.remove(handle);
            }
            idleClocks.remove(registration.sessionHandleId());
        }
        sessions.put(registration.sessionHandleId(), updated);
        idleClocks.computeIfAbsent(registration.sessionHandleId(), ignored -> new ClawBotSessionIdleClock(ticker.getAsLong()));
        heartbeatTicks.put(registration.sessionHandleId(), ticker.getAsLong());
        pendingMessages.computeIfAbsent(registration.sessionHandleId(), ignored -> new ArrayDeque<>());
        pendingCommands.computeIfAbsent(registration.sessionHandleId(), ignored -> new ArrayDeque<>());
        dispatchedMessages.computeIfAbsent(registration.sessionHandleId(), ignored -> new HashSet<>());
        dispatchedCommands.computeIfAbsent(registration.sessionHandleId(), ignored -> new HashSet<>());
        return true;
    }

    /** Replaces all sessions owned by one client epoch as one reconnect operation. */
    public synchronized boolean replaceSnapshot(
            String instanceId, long connectionEpoch, List<ClawBotSessionRegistration> registrations) {
        requireId(instanceId, "instanceId");
        if (connectionEpoch < 0) {
            throw new IllegalArgumentException("connectionEpoch must not be negative");
        }
        Objects.requireNonNull(registrations, "registrations");
        Map<String, ClawBotSessionSnapshot> updated = new HashMap<>(sessions);
        for (ClawBotSessionRegistration registration : registrations) {
            Objects.requireNonNull(registration, "registration");
            if (!instanceId.equals(registration.instanceId())
                    || registration.connectionEpoch() != connectionEpoch) {
                return false;
            }
            ClawBotSessionSnapshot current = updated.get(registration.sessionHandleId());
            if (current != null && !isNewer(registration, current)) {
                return false;
            }
            long now = clock.millis();
            updated.put(registration.sessionHandleId(), new ClawBotSessionSnapshot(
                    registration.sessionHandleId(), registration.instanceId(), registration.projectId(),
                    registration.projectDisplayName(), registration.provider(), registration.capabilities(),
                    registration.status(), registration.connectionEpoch(), now, now, registration.tabDisplayName(), registration.generation(), 0));
        }
        updated.entrySet().removeIf(entry -> {
            ClawBotSessionSnapshot session = entry.getValue();
            return instanceId.equals(session.instanceId())
                    && session.connectionEpoch() <= connectionEpoch
                    && registrations.stream().noneMatch(
                            registration -> registration.sessionHandleId().equals(session.sessionHandleId()));
        });
        for (ClawBotSessionRegistration registration : registrations) {
            ClawBotSessionSnapshot current = sessions.get(registration.sessionHandleId());
            if (current != null && !sameTarget(registration, current)) {
                String handle = registration.sessionHandleId();
                if (sameOwner(registration, current)) {
                    ClawBotSessionSnapshot next = updated.get(handle);
                    pruneStaleUndispatched(pendingMessages.get(handle), dispatchedMessages.get(handle), next);
                    pruneStaleUndispatched(pendingCommands.get(handle), dispatchedCommands.get(handle), next);
                } else {
                    pendingMessages.remove(handle);
                    pendingCommands.remove(handle);
                    dispatchedMessages.remove(handle);
                    dispatchedCommands.remove(handle);
                }
                idleClocks.remove(registration.sessionHandleId());
            }
        }
        sessions.clear();
        sessions.putAll(updated);
        pendingMessages.keySet().removeIf(sessionHandleId -> !updated.containsKey(sessionHandleId));
        pendingCommands.keySet().removeIf(sessionHandleId -> !updated.containsKey(sessionHandleId));
        dispatchedMessages.keySet().removeIf(sessionHandleId -> !updated.containsKey(sessionHandleId));
        dispatchedCommands.keySet().removeIf(sessionHandleId -> !updated.containsKey(sessionHandleId));
        idleClocks.keySet().removeIf(sessionHandleId -> !updated.containsKey(sessionHandleId));
        heartbeatTicks.keySet().removeIf(sessionHandleId -> !updated.containsKey(sessionHandleId));
        for (ClawBotSessionRegistration registration : registrations) {
            heartbeatTicks.put(registration.sessionHandleId(), ticker.getAsLong());
            idleClocks.computeIfAbsent(registration.sessionHandleId(), ignored -> new ClawBotSessionIdleClock(ticker.getAsLong()));
            pendingMessages.computeIfAbsent(registration.sessionHandleId(), ignored -> new ArrayDeque<>());
            pendingCommands.computeIfAbsent(registration.sessionHandleId(), ignored -> new ArrayDeque<>());
            dispatchedMessages.computeIfAbsent(registration.sessionHandleId(), ignored -> new HashSet<>());
            dispatchedCommands.computeIfAbsent(registration.sessionHandleId(), ignored -> new HashSet<>());
        }
        return true;
    }

    /** Renews a heartbeat only for the current instance and connection epoch. */
    public synchronized boolean heartbeat(
            String sessionHandleId, String instanceId, long connectionEpoch, ClawBotSessionStatus status) {
        requireId(sessionHandleId, "sessionHandleId");
        requireId(instanceId, "instanceId");
        Objects.requireNonNull(status, "status");
        markStale();
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        if (current == null || !current.instanceId().equals(instanceId)
                || current.connectionEpoch() != connectionEpoch
                || current.status() == ClawBotSessionStatus.STALE || current.status() == ClawBotSessionStatus.OFFLINE) {
            return false;
        }
        sessions.put(sessionHandleId, current.withHeartbeat(status, clock.millis()));
        heartbeatTicks.put(sessionHandleId, ticker.getAsLong());
        return true;
    }

    /** Removes a session only when the unregistering client still owns its epoch. */
    public synchronized boolean unregister(String sessionHandleId, String instanceId, long connectionEpoch) {
        requireId(sessionHandleId, "sessionHandleId");
        requireId(instanceId, "instanceId");
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        if (current == null || !current.instanceId().equals(instanceId)
                || current.connectionEpoch() != connectionEpoch) {
            return false;
        }
        sessions.remove(sessionHandleId);
        pendingMessages.remove(sessionHandleId);
        pendingCommands.remove(sessionHandleId);
        dispatchedMessages.remove(sessionHandleId);
        dispatchedCommands.remove(sessionHandleId);
        idleClocks.remove(sessionHandleId);
        heartbeatTicks.remove(sessionHandleId);
        return true;
    }

    /** Queues one inbound message for an online session with the inbound capability. */
    public synchronized boolean enqueueInbound(String sessionHandleId, ClawBotInboundMessage message) {
        return enqueue(sessionHandleId, message, "INBOUND");
    }

    /** Queues a control action only for a session that explicitly advertises control capability. */
    public synchronized boolean enqueueCommand(String sessionHandleId, ClawBotInboundMessage message) {
        requireId(sessionHandleId, "sessionHandleId");
        Objects.requireNonNull(message, "message");
        markStale();
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        if (current == null || (current.status() != ClawBotSessionStatus.ONLINE
                && current.status() != ClawBotSessionStatus.BUSY)
                || !current.capabilities().contains("CONTROL")
                || message.target() != null && !message.target().matches(current)) {
            return false;
        }
        Deque<ClawBotInboundMessage> queue = pendingCommands.computeIfAbsent(
                sessionHandleId, ignored -> new ArrayDeque<>());
        if (queue.size() >= MAX_PENDING_MESSAGES_PER_SESSION) {
            return false;
        }
        queue.addLast(message);
        return true;
    }

    /** Removes gateway-queued inbound messages from a sender whose access was revoked. */
    public synchronized void clearPendingMessagesFromSender(String senderId) {
        Objects.requireNonNull(senderId, "senderId");
        pendingMessages.forEach((sessionHandleId, queue) -> {
            Set<String> dispatched = dispatchedMessages.get(sessionHandleId);
            queue.removeIf(message -> {
                boolean matches = message.fromUserId().equals(senderId);
                if (matches && dispatched != null) {
                    dispatched.remove(message.messageId());
                }
                return matches;
            });
        });
        pendingCommands.forEach((sessionHandleId, queue) -> {
            Set<String> dispatched = dispatchedCommands.get(sessionHandleId);
            queue.removeIf(message -> {
                boolean matches = message.fromUserId().equals(senderId);
                if (matches && dispatched != null) {
                    dispatched.remove(message.messageId());
                }
                return matches;
            });
        });
    }

    /** Clears queued inbound messages when the bound account or transport is removed. */
    public synchronized void clearPendingMessages() {
        pendingMessages.values().forEach(java.util.Deque::clear);
        pendingCommands.values().forEach(java.util.Deque::clear);
        dispatchedMessages.values().forEach(Set::clear);
        dispatchedCommands.values().forEach(Set::clear);
    }

    private boolean enqueue(String sessionHandleId, ClawBotInboundMessage message, String capability) {
        requireId(sessionHandleId, "sessionHandleId");
        Objects.requireNonNull(message, "message");
        markStale();
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        if (current == null || (current.status() != ClawBotSessionStatus.ONLINE
                && current.status() != ClawBotSessionStatus.BUSY)
                || !current.capabilities().contains(capability)
                || message.target() != null && !message.target().matches(current)) {
            return false;
        }
        Deque<ClawBotInboundMessage> queue = pendingMessages.computeIfAbsent(
                sessionHandleId, ignored -> new ArrayDeque<>());
        if (queue.size() >= MAX_PENDING_MESSAGES_PER_SESSION) {
            return false;
        }
        queue.addLast(message);
        return true;
    }

    /** Returns the head message until the owner confirms its reply. */
    public synchronized ClawBotInboundMessage pollInbound(
            String sessionHandleId, String instanceId, long connectionEpoch) {
        requireId(sessionHandleId, "sessionHandleId");
        requireId(instanceId, "instanceId");
        markStale();
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        if (current == null || !current.instanceId().equals(instanceId)
                || current.connectionEpoch() != connectionEpoch) {
            return null;
        }
        Deque<ClawBotInboundMessage> queue = pendingMessages.get(sessionHandleId);
        if (queue != null) {
            pruneStaleUndispatched(queue, dispatchedMessages.get(sessionHandleId), current);
        }
        return queue == null ? null : queue.peekFirst();
    }

    /** Removes only the message currently at the head of the owner's queue. */
    public synchronized boolean acknowledgeInbound(
            String sessionHandleId, String instanceId, long connectionEpoch, String messageId) {
        requireId(messageId, "messageId");
        ClawBotInboundMessage current = pollInbound(sessionHandleId, instanceId, connectionEpoch);
        if (current == null || !current.messageId().equals(messageId)) {
            return false;
        }
        pendingMessages.get(sessionHandleId).removeFirst();
        Set<String> dispatched = dispatchedMessages.get(sessionHandleId);
        if (dispatched != null) {
            dispatched.remove(messageId);
        }
        return true;
    }

    /** Marks a validated inbound message as accepted by the owning IDE turn. */
    public synchronized boolean markInboundDispatched(
            String sessionHandleId, String instanceId, long connectionEpoch, String messageId) {
        ClawBotInboundMessage current = pollInbound(sessionHandleId, instanceId, connectionEpoch);
        if (current == null || !current.messageId().equals(messageId)) {
            return false;
        }
        dispatchedMessages.computeIfAbsent(sessionHandleId, ignored -> new HashSet<>()).add(messageId);
        return true;
    }

    /** Returns whether the owning IDE has already accepted an inbound message for execution. */
    public synchronized boolean isInboundDispatched(
            String sessionHandleId, String instanceId, long connectionEpoch, String messageId) {
        if (!isOwner(sessionHandleId, instanceId, connectionEpoch)) {
            return false;
        }
        Set<String> dispatched = dispatchedMessages.get(sessionHandleId);
        return dispatched != null && dispatched.contains(messageId);
    }

    /** Returns the head control action independently of ordinary messages. */
    public synchronized ClawBotInboundMessage pollCommand(
            String sessionHandleId, String instanceId, long connectionEpoch) {
        requireId(sessionHandleId, "sessionHandleId");
        requireId(instanceId, "instanceId");
        markStale();
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        if (current == null || !current.instanceId().equals(instanceId)
                || current.connectionEpoch() != connectionEpoch) {
            return null;
        }
        Deque<ClawBotInboundMessage> queue = pendingCommands.get(sessionHandleId);
        if (queue != null) {
            pruneStaleUndispatched(queue, dispatchedCommands.get(sessionHandleId), current);
        }
        return queue == null ? null : queue.peekFirst();
    }

    /** Acknowledges only the current control action for its owning IDE connection. */
    public synchronized boolean acknowledgeCommand(
            String sessionHandleId, String instanceId, long connectionEpoch, String messageId) {
        requireId(messageId, "messageId");
        ClawBotInboundMessage current = pollCommand(sessionHandleId, instanceId, connectionEpoch);
        if (current == null || !current.messageId().equals(messageId)) {
            return false;
        }
        pendingCommands.get(sessionHandleId).removeFirst();
        Set<String> dispatched = dispatchedCommands.get(sessionHandleId);
        if (dispatched != null) {
            dispatched.remove(messageId);
        }
        return true;
    }

    /** Marks a validated control action as accepted by the owning IDE. */
    public synchronized boolean markCommandDispatched(
            String sessionHandleId, String instanceId, long connectionEpoch, String messageId) {
        ClawBotInboundMessage current = pollCommand(sessionHandleId, instanceId, connectionEpoch);
        if (current == null || !current.messageId().equals(messageId)) {
            return false;
        }
        dispatchedCommands.computeIfAbsent(sessionHandleId, ignored -> new HashSet<>()).add(messageId);
        return true;
    }

    /** Returns whether the owning IDE has already accepted a control action. */
    public synchronized boolean isCommandDispatched(
            String sessionHandleId, String instanceId, long connectionEpoch, String messageId) {
        if (!isOwner(sessionHandleId, instanceId, connectionEpoch)) {
            return false;
        }
        Set<String> dispatched = dispatchedCommands.get(sessionHandleId);
        return dispatched != null && dispatched.contains(messageId);
    }

    /** Returns whether the supplied IDE connection still owns the session. */
    public synchronized boolean isOwner(String sessionHandleId, String instanceId, long connectionEpoch) {
        requireId(sessionHandleId, "sessionHandleId");
        requireId(instanceId, "instanceId");
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        return current != null && current.instanceId().equals(instanceId)
                && current.connectionEpoch() == connectionEpoch;
    }

    /** Marks expired online sessions stale and returns the number changed. */
    public synchronized int markStale() {
        long now = ticker.getAsLong();
        int changed = 0;
        for (Map.Entry<String, ClawBotSessionSnapshot> entry : sessions.entrySet()) {
            ClawBotSessionSnapshot current = entry.getValue();
            if ((current.status() == ClawBotSessionStatus.ONLINE
                    || current.status() == ClawBotSessionStatus.BUSY)
                    && (now < heartbeatTicks.get(entry.getKey())
                    || now - heartbeatTicks.get(entry.getKey()) >= TimeUnit.MILLISECONDS.toNanos(staleAfterMillis))) {
                entry.setValue(current.withStatus(ClawBotSessionStatus.STALE));
                Deque<ClawBotInboundMessage> queue = pendingMessages.get(entry.getKey());
                if (queue != null) {
                    queue.clear();
                }
                Deque<ClawBotInboundMessage> commands = pendingCommands.get(entry.getKey());
                if (commands != null) {
                    commands.clear();
                }
                Set<String> dispatched = dispatchedMessages.get(entry.getKey());
                if (dispatched != null) {
                    dispatched.clear();
                }
                Set<String> dispatchedControl = dispatchedCommands.get(entry.getKey());
                if (dispatchedControl != null) {
                    dispatchedControl.clear();
                }
                changed++;
            }
        }
        return changed;
    }

    /** Returns an immutable snapshot ordered by display name and session handle. */
    public synchronized List<ClawBotSessionSnapshot> snapshot() {
        markStale();
        List<ClawBotSessionSnapshot> result = new ArrayList<>(sessions.values());
        result.replaceAll(session -> session.withIdleMillis(idleClocks.get(session.sessionHandleId()).observe(ticker.getAsLong())));
        result.sort(Comparator.comparing(ClawBotSessionSnapshot::projectDisplayName)
                .thenComparing(ClawBotSessionSnapshot::tabDisplayName)
                .thenComparing(ClawBotSessionSnapshot::sessionHandleId));
        return List.copyOf(result);
    }

    public synchronized boolean reportActivity(String sessionHandleId, String instanceId, long connectionEpoch,
            String generation, String activeTurnId) {
        requireId(generation, "generation");
        if (!activeTurnId.isEmpty()) {
            requireId(activeTurnId, "activeTurnId");
        }
        ClawBotSessionSnapshot current = sessions.get(sessionHandleId);
        if (!isOwner(sessionHandleId, instanceId, connectionEpoch) || !current.generation().equals(generation)) {
            return false;
        }
        idleClocks.get(sessionHandleId).report(!activeTurnId.isEmpty(), ticker.getAsLong());
        return true;
    }

    private static void pruneStaleUndispatched(
            Deque<ClawBotInboundMessage> queue,
            Set<String> dispatched,
            ClawBotSessionSnapshot current) {
        if (queue == null) {
            return;
        }
        queue.removeIf(message -> message.target() != null
                && (dispatched == null || !dispatched.contains(message.messageId()))
                && !message.target().matches(current));
    }

    private static boolean sameOwner(ClawBotSessionRegistration registration, ClawBotSessionSnapshot current) {
        return current.instanceId().equals(registration.instanceId())
                && current.connectionEpoch() == registration.connectionEpoch();
    }

    private static boolean sameTarget(ClawBotSessionRegistration registration, ClawBotSessionSnapshot current) {
        return current.instanceId().equals(registration.instanceId())
                && current.connectionEpoch() == registration.connectionEpoch()
                && current.provider().equals(registration.provider())
                && current.generation().equals(registration.generation());
    }

    private static boolean isNewer(
            ClawBotSessionRegistration registration, ClawBotSessionSnapshot current) {
        return registration.connectionEpoch() > current.connectionEpoch()
                || registration.connectionEpoch() == current.connectionEpoch()
                && registration.instanceId().equals(current.instanceId());
    }

    private static void requireId(String value, String name) {
        if (value == null || value.isBlank() || value.length() > 256 || containsControl(value)) {
            throw new IllegalArgumentException("Invalid " + name);
        }
    }

    private static boolean containsControl(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) {
                return true;
            }
        }
        return false;
    }
}
