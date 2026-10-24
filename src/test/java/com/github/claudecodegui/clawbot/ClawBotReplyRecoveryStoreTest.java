package com.github.claudecodegui.clawbot;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class ClawBotReplyRecoveryStoreTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private ClawBotInboundMessage message() {
        return new ClawBotInboundMessage("message", "test-recipient", "test-context", "prompt")
                .forTarget(new ClawBotSessionSnapshot("handle", "instance", "project", "Project", "codex",
                        java.util.Set.of("INBOUND"), ClawBotSessionStatus.ONLINE, 1, 0, 0, "Tab", "generation", 0));
    }

    @Test
    public void completeEscapedAnswerAndClaimSurviveEncryptedReload() throws Exception {
        Path directory = temporaryFolder.newFolder().toPath();
        ClawBotReplyRecoveryStore store = new ClawBotReplyRecoveryStore(directory);
        String id = UUID.randomUUID().toString();
        String text = "\n\"\\".repeat(20000);
        store.retain(id, message(), text, 7, 1000, "test-token");
        assertFalse(new String(Files.readAllBytes(directory.resolve("reply-recovery.enc")), StandardCharsets.UTF_8).contains("test-recipient"));
        var reply = store.replies(1001, "test-token").get(0);
        String retry = UUID.randomUUID().toString();
        store.claim(reply, retry, "test-token");
        store = new ClawBotReplyRecoveryStore(directory);
        assertEquals(text, store.replies(1002, "test-token").get(0).text());
        assertEquals(retry, store.replies(1002, "test-token").get(0).retryId());
        assertThrows(IOException.class, () -> new ClawBotReplyRecoveryStore(directory).replies(1002, "different-token"));
    }

    @Test
    public void expiryAndRevocationRemoveRetainedBodies() throws Exception {
        ClawBotReplyRecoveryStore store = new ClawBotReplyRecoveryStore(temporaryFolder.newFolder().toPath());
        store.retain(UUID.randomUUID().toString(), message(), "answer", 1, 1000, "test-token");
        assertTrue(store.replies(1000 + ClawBotReplyRecoveryStore.RETENTION_MILLIS, "test-token").isEmpty());
        store.retain(UUID.randomUUID().toString(), message(), "answer", 1, 2000, "test-token");
        store.removeRecipient("test-recipient", "test-token");
        assertTrue(store.replies(2001, "test-token").isEmpty());
    }

    @Test
    public void duplicateRetentionKeepsOriginalAnswerAndRecoveryClaim() throws Exception {
        ClawBotReplyRecoveryStore store = new ClawBotReplyRecoveryStore(temporaryFolder.newFolder().toPath());
        String id = UUID.randomUUID().toString();
        store.retain(id, message(), "original", 1, 1000, "test-token");
        store.claim(store.replies(1001, "test-token").get(0), "retry-id", "test-token");
        store.retain(id, message(), "replacement", 1, 1002, "test-token");
        assertEquals("original", store.replies(1003, "test-token").get(0).text());
        assertEquals("retry-id", store.replies(1003, "test-token").get(0).retryId());
    }
}
