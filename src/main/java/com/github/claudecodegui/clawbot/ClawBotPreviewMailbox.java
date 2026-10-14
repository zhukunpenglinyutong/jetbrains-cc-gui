package com.github.claudecodegui.clawbot;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;
import java.util.function.Predicate;

final class ClawBotPreviewMailbox {

    private static final int MAX_PENDING = 128;
    private final Map<String, Pending> pending = new LinkedHashMap<>();
    private final LongSupplier ticker;

    ClawBotPreviewMailbox() {
        this(System::nanoTime);
    }

    ClawBotPreviewMailbox(LongSupplier ticker) {
        this.ticker = ticker;
    }

    synchronized void request(ClawBotInboundMessage message) {
        pending.values().removeIf(value -> value.message().fromUserId().equals(message.fromUserId()));
        pending.put(message.messageId(), new Pending(message, ticker.getAsLong()));
        while (pending.size() > MAX_PENDING) {
            pending.remove(pending.keySet().iterator().next());
        }
    }

    List<ClawBotInboundMessage> sweep(Predicate<ClawBotInboundMessage> valid) {
        long now = ticker.getAsLong();
        List<Pending> candidates;
        List<ClawBotInboundMessage> expiredMessages = new java.util.ArrayList<>();
        synchronized (this) {
            candidates = List.copyOf(pending.values());
        }
        for (Pending value : candidates) {
            boolean expired = now < value.createdAt()
                    || now - value.createdAt() >= TimeUnit.SECONDS.toNanos(5);
            if (expired || !valid.test(value.message())) {
                synchronized (this) {
                    if (pending.remove(value.message().messageId(), value) && expired) {
                        expiredMessages.add(value.message());
                    }
                }
            }
        }
        return List.copyOf(expiredMessages);
    }

    synchronized ClawBotInboundMessage poll(String handle, String instanceId, long epoch) {
        return pending.values().stream().map(Pending::message).filter(message -> owned(message, handle, instanceId, epoch))
                .findFirst().orElse(null);
    }

    synchronized ClawBotInboundMessage take(String id, String handle, String instanceId, long epoch) {
        Pending value = pending.get(id);
        if (value == null || !owned(value.message(), handle, instanceId, epoch)) {
            return null;
        }
        pending.remove(id);
        return value.message();
    }

    synchronized void clear() {
        pending.clear();
    }

    synchronized void cancelSender(String sender) {
        pending.values().removeIf(value -> value.message().fromUserId().equals(sender));
    }

    private static boolean owned(ClawBotInboundMessage message, String handle, String instanceId, long epoch) {
        ClawBotSessionTarget target = message.target();
        return target != null && target.handle().equals(handle) && target.instanceId().equals(instanceId)
                && target.connectionEpoch() == epoch;
    }

    private record Pending(ClawBotInboundMessage message, long createdAt) {
    }
}
