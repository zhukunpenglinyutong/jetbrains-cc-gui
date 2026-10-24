package com.github.claudecodegui.pet.office;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** Bounded navigation-only mailbox. A handoff is bound to one authenticated connection and never replayed. */
final class PetOfficeRouteBroker implements AutoCloseable {
    static final long DEADLINE_MILLIS = 3000;
    private final PetOfficeParticipantRegistry registry;
    private final BooleanSupplier ownsLease;
    private final LongSupplier nanoTime;
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final Map<String, Long> seen = new LinkedHashMap<>();
    private boolean closed;

    record Command(String page, String ticket, PetOfficeTabNavigator.Request request, long remainingMillis) { }
    record Reply(String requestId, String ticket, PetOfficeTabNavigator.Result result) { }

    PetOfficeRouteBroker(PetOfficeParticipantRegistry registry, BooleanSupplier ownsLease) {
        this(registry, ownsLease, System::nanoTime);
    }

    PetOfficeRouteBroker(PetOfficeParticipantRegistry registry, BooleanSupplier ownsLease, LongSupplier nanoTime) {
        this.registry = registry;
        this.ownsLease = ownsLease;
        this.nanoTime = nanoTime;
    }

    synchronized void submit(String page, PetOfficeTabNavigator.Request request, BooleanSupplier pageValid,
                             Consumer<PetOfficeTabNavigator.Result> completed, long receivedAt) {
        expire();
        if (closed || !ownsLease.getAsBoolean() || !pageValid.getAsBoolean() || pending.size() >= 16
                || seen.size() >= 256 || seen.containsKey(request.requestId()) || age(receivedAt) >= DEADLINE_MILLIS) {
            completed.accept(PetOfficeTabNavigator.Result.UNAVAILABLE);
            return;
        }
        seen.put(request.requestId(), nanoTime.getAsLong());
        PetOfficeParticipantRegistry.Connection target;
        try {
            target = registry.route(request);
        } catch (IOException | RuntimeException invalid) {
            target = null;
        }
        if (target == null) {
            completed.accept(PetOfficeTabNavigator.Result.TARGET_GONE);
            return;
        }
        pending.put(request.requestId(), new Pending(page, UUID.randomUUID().toString(), request, target, pageValid, completed, receivedAt));
    }

    synchronized List<Command> poll(PetOfficeParticipantRegistry.Connection connection) {
        expire();
        List<Command> commands = new ArrayList<>();
        for (Pending action : pending.values()) {
            if (action.target == connection && !action.delivered && valid(action) && registry.routeCurrent(connection, action.request)) {
                // This is the commit boundary. Closing the originating page cannot undo a dispatched focus action.
                action.delivered = true;
                commands.add(new Command(action.page, action.ticket, action.request, DEADLINE_MILLIS - age(action.receivedAt)));
                if (commands.size() == 4) {
                    break;
                }
            }
        }
        return List.copyOf(commands);
    }

    synchronized void complete(PetOfficeParticipantRegistry.Connection connection, Reply reply) {
        expire();
        Pending action = pending.get(reply.requestId());
        if (action != null && action.delivered && action.target == connection && action.ticket.equals(reply.ticket())
                && valid(action) && registry.routeCurrent(connection, action.request)) {
            pending.remove(reply.requestId());
            action.completed.accept(reply.result());
        }
    }

    synchronized void expire() {
        List<Pending> retired = new ArrayList<>();
        pending.values().removeIf(action -> {
            boolean expired = !valid(action) || !registry.routeCurrent(action.target, action.request);
            if (expired) {
                retired.add(action);
            }
            return expired;
        });
        seen.values().removeIf(started -> age(started) >= 30_000);
        for (Pending action : retired) {
            if (action.pageValid.getAsBoolean()) {
                action.completed.accept(PetOfficeTabNavigator.Result.UNAVAILABLE);
            }
        }
    }

    synchronized void closePage(String page) {
        pending.values().removeIf(action -> action.page.equals(page));
    }

    private boolean valid(Pending action) {
        return !closed && ownsLease.getAsBoolean() && action.pageValid.getAsBoolean() && age(action.receivedAt) < DEADLINE_MILLIS;
    }

    private long age(long started) {
        return Math.max(0, (nanoTime.getAsLong() - started) / 1_000_000);
    }

    @Override
    public synchronized void close() {
        closed = true;
        pending.clear();
        seen.clear();
    }

    private static final class Pending {
        private final String page;
        private final String ticket;
        private final PetOfficeTabNavigator.Request request;
        private final PetOfficeParticipantRegistry.Connection target;
        private final BooleanSupplier pageValid;
        private final Consumer<PetOfficeTabNavigator.Result> completed;
        private final long receivedAt;
        private boolean delivered;

        private Pending(String page, String ticket, PetOfficeTabNavigator.Request request, PetOfficeParticipantRegistry.Connection target,
                        BooleanSupplier pageValid, Consumer<PetOfficeTabNavigator.Result> completed, long receivedAt) {
            this.page = page;
            this.ticket = ticket;
            this.request = request;
            this.target = target;
            this.pageValid = pageValid;
            this.completed = completed;
            this.receivedAt = receivedAt;
        }
    }
}
