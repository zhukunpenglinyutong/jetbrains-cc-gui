package com.github.claudecodegui.clawbot;

import com.google.gson.Gson;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Retains complete terminal replies and one durable manual-recovery claim in encrypted storage. */
final class ClawBotReplyRecoveryStore {
    static final long RETENTION_MILLIS = TimeUnit.HOURS.toMillis(24);
    private static final Gson GSON = new Gson();
    private final ClawBotPendingDeliveryStore store;

    ClawBotReplyRecoveryStore(Path directory) {
        // JSON escaping can expand a complete reply beyond its original text limit.
        store = new ClawBotPendingDeliveryStore(directory, "reply-recovery.enc", ClawBotInboundMessage.MAX_TEXT_LENGTH * 6 + 8192);
    }

    void reload() {
        store.reload();
    }

    synchronized void retain(String eventId, ClawBotInboundMessage message, String text, long bindingRevision, long now, String token) throws IOException {
        prune(now, token);
        if (message.target() == null) {
            return;
        }
        Reply reply = new Reply(eventId, message.fromUserId(), message.contextToken(), text, message.target(),
                bindingRevision, now, now + RETENTION_MILLIS, "");
        store.put(delivery(reply), token);
    }

    synchronized List<Reply> replies(long now, String token) throws IOException {
        prune(now, token);
        return store.pending(token).stream().map(ClawBotReplyRecoveryStore::parse).toList();
    }

    synchronized Reply claim(Reply reply, String retryId, String token) throws IOException {
        Reply claimed = new Reply(reply.eventId(), reply.recipient(), reply.context(), reply.text(), reply.target(),
                reply.bindingRevision(), reply.createdAt(), reply.expiresAt(), retryId);
        store.replace(delivery(claimed), token);
        return claimed;
    }

    void removeRecipient(String recipient, String token) throws IOException {
        store.removeRecipient(recipient, token);
    }

    void clear() throws IOException {
        store.clear();
    }

    private void prune(long now, String token) throws IOException {
        for (var entry : store.pending(token)) {
            if (parse(entry).expiresAt() <= now) {
                store.remove(entry.id(), token);
            }
        }
    }

    private static ClawBotPendingDeliveryStore.Delivery delivery(Reply reply) {
        // Archived entries have a separate bounded capacity and never enter the automatic delivery loop.
        return new ClawBotPendingDeliveryStore.Delivery(reply.eventId(), reply.recipient(), reply.context(),
                GSON.toJson(reply), true, null, true);
    }

    private static Reply parse(ClawBotPendingDeliveryStore.Delivery entry) {
        Reply reply = GSON.fromJson(entry.text(), Reply.class);
        if (reply == null || !entry.id().equals(reply.eventId()) || !entry.recipient().equals(reply.recipient())
                || !entry.context().equals(reply.context()) || reply.text() == null || reply.text().length() > ClawBotInboundMessage.MAX_TEXT_LENGTH
                || reply.target() == null || reply.createdAt() < 0 || reply.expiresAt() != reply.createdAt() + RETENTION_MILLIS
                || reply.bindingRevision() < 0 || reply.retryId() == null) {
            throw new IllegalArgumentException("Invalid retained reply");
        }
        return reply;
    }

    record Reply(String eventId, String recipient, String context, String text, ClawBotSessionTarget target,
                 long bindingRevision, long createdAt, long expiresAt, String retryId) { }
}
