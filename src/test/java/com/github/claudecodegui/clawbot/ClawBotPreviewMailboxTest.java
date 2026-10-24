package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class ClawBotPreviewMailboxTest {

    @Test
    public void pinnedPreviewCanOnlyBeConsumedOnceByItsOwner() {
        ClawBotPreviewMailbox mailbox = new ClawBotPreviewMailbox(() -> 0);
        ClawBotInboundMessage message = request("one");
        mailbox.request(message);
        assertNull(mailbox.poll("session", "other", 1));
        assertNull(mailbox.take("one", "session", "ide", 2));
        assertEquals(message, mailbox.poll("session", "ide", 1));
        assertEquals(message, mailbox.take("one", "session", "ide", 1));
        assertNull(mailbox.take("one", "session", "ide", 1));
    }

    @Test
    public void newSelectionReplacesOldRequestAndExpiryDropsContent() {
        AtomicLong ticker = new AtomicLong();
        ClawBotPreviewMailbox mailbox = new ClawBotPreviewMailbox(ticker::get);
        mailbox.request(request("one"));
        mailbox.request(request("two"));
        assertNull(mailbox.take("one", "session", "ide", 1));
        ticker.set(TimeUnit.SECONDS.toNanos(5));
        assertEquals(List.of("two"), mailbox.sweep(message -> true).stream()
                .map(ClawBotInboundMessage::messageId).toList());
        assertNull(mailbox.poll("session", "ide", 1));
    }

    @Test
    public void invalidationDoesNotProduceTimeoutNotification() {
        ClawBotPreviewMailbox mailbox = new ClawBotPreviewMailbox(() -> 0);
        mailbox.request(request("one"));
        assertEquals(List.of(), mailbox.sweep(message -> false));
    }

    @Test
    public void revocationOrRouteInvalidationCancelsPreview() {
        ClawBotPreviewMailbox mailbox = new ClawBotPreviewMailbox(() -> 0);
        mailbox.request(request("one"));
        mailbox.sweep(message -> false);
        assertNull(mailbox.poll("session", "ide", 1));
    }

    @Test
    public void validityCheckCanReplaceMailboxContentWithoutConcurrentModification() {
        ClawBotPreviewMailbox mailbox = new ClawBotPreviewMailbox(() -> 0);
        mailbox.request(request("one"));

        mailbox.sweep(message -> {
            mailbox.request(request("replacement"));
            return false;
        });

        assertEquals("replacement", mailbox.poll("session", "ide", 1).messageId());
    }

    private static ClawBotInboundMessage request(String id) {
        ClawBotSessionSnapshot target = new ClawBotSessionSnapshot("session", "ide", "project", "Project", "codex",
                Set.of("INBOUND", "ROUTING_V2"), ClawBotSessionStatus.ONLINE, 1, 1, 1, "Chat", "generation", 0);
        return new ClawBotInboundMessage(id, "user", "context", "/use session").forTarget(target).forRoute(1);
    }
}
