package com.github.claudecodegui.clawbot;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

public class ClawBotOutboundReceiptStoreTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void followerDiagnosticsNeverRewritePendingAndTakeoverReloadsLatestReceipt() throws Exception {
        Path directory = temporaryFolder.newFolder().toPath();
        var leader = new ClawBotOutboundReceiptStore(directory);
        var follower = new ClawBotOutboundReceiptStore(directory);
        follower.status();
        String id = UUID.randomUUID().toString();
        leader.begin(id, 100L);
        String before = Files.readString(directory.resolve("outbound-receipts.json"));
        assertEquals(1, follower.readOnlyStatus().pendingCount());
        assertEquals(before, Files.readString(directory.resolve("outbound-receipts.json")));
        leader.complete(id, "SENT", null, 101L);
        follower.reload();
        assertEquals("SENT", follower.statusOf(id));
    }

    @Test
    public void recordsRedactedSendOutcomesAndCounts() throws Exception {
        Path runtimeDirectory = temporaryFolder.newFolder("outbound-receipts").toPath();
        ClawBotOutboundReceiptStore store = new ClawBotOutboundReceiptStore(runtimeDirectory);
        String sentId = UUID.randomUUID().toString();
        String unknownId = UUID.randomUUID().toString();

        store.begin(sentId, 100L);
        store.complete(sentId, "SENT", null, 110L);
        store.begin(unknownId, 120L);
        store.complete(unknownId, "UNKNOWN", "ILINK_SEND_RESULT_UNKNOWN", 130L);

        ClawBotOutboundReceiptStore.StatusSnapshot status = store.status();
        assertTrue(status.available());
        assertEquals(1, status.sentCount());
        assertEquals(1, status.unknownCount());
        assertEquals(0, status.pendingCount());
        assertEquals("UNKNOWN", status.latestStatus());
        assertEquals("ILINK_SEND_RESULT_UNKNOWN", status.latestErrorCode());

        String persisted = Files.readString(runtimeDirectory.resolve("outbound-receipts.json"));
        assertFalse(persisted.contains("message body"));
        assertFalse(persisted.contains("recipient-id"));
        assertFalse(persisted.contains("context-token"));
    }

    @Test
    public void marksPendingSendsUnknownAfterGatewayRestartWithoutRetrying() throws Exception {
        Path runtimeDirectory = temporaryFolder.newFolder("outbound-restart").toPath();
        String clientId = UUID.randomUUID().toString();
        ClawBotOutboundReceiptStore firstRun = new ClawBotOutboundReceiptStore(runtimeDirectory);
        firstRun.begin(clientId, 100L);

        ClawBotOutboundReceiptStore.StatusSnapshot recovered =
                new ClawBotOutboundReceiptStore(runtimeDirectory).status();

        assertEquals(0, recovered.pendingCount());
        assertEquals(1, recovered.unknownCount());
        assertEquals("UNKNOWN", recovered.latestStatus());
        assertEquals("CLAWBOT_GATEWAY_RESTARTED", recovered.latestErrorCode());
    }

    @Test
    public void rejectsCompletionForMissingReceipt() throws Exception {
        ClawBotOutboundReceiptStore store = new ClawBotOutboundReceiptStore(
                temporaryFolder.newFolder("outbound-missing").toPath());

        boolean rejected = false;
        try {
            store.complete(UUID.randomUUID().toString(), "SENT", null, 100L);
        } catch (java.io.IOException expected) {
            rejected = true;
        }
        assertTrue(rejected);
    }

    @Test
    public void evictsCompletedHistoryBeforePendingReceipts() throws Exception {
        ClawBotOutboundReceiptStore store = new ClawBotOutboundReceiptStore(
                temporaryFolder.newFolder("outbound-prune-pending").toPath());
        String pendingId = UUID.randomUUID().toString();
        store.begin(pendingId, 100L);
        String firstCompletedId = null;
        for (int index = 0; index < 255; index++) {
            String completedId = UUID.randomUUID().toString();
            if (firstCompletedId == null) {
                firstCompletedId = completedId;
            }
            long timestamp = 200L + index * 2L;
            store.begin(completedId, timestamp);
            store.complete(completedId, "SENT", null, timestamp + 1L);
        }
        String newestId = UUID.randomUUID().toString();

        store.begin(newestId, 1000L);

        assertEquals("PENDING", store.statusOf(pendingId));
        assertEquals("", store.statusOf(firstCompletedId));
        assertEquals("PENDING", store.statusOf(newestId));
    }

    @Test
    public void refusesNewReceiptWhenAllRetainedEntriesArePending() throws Exception {
        ClawBotOutboundReceiptStore store = new ClawBotOutboundReceiptStore(
                temporaryFolder.newFolder("outbound-pending-capacity").toPath());
        String firstPendingId = null;
        for (int index = 0; index < 256; index++) {
            String pendingId = UUID.randomUUID().toString();
            if (firstPendingId == null) {
                firstPendingId = pendingId;
            }
            store.begin(pendingId, 100L + index);
        }
        String rejectedId = UUID.randomUUID().toString();

        assertThrows(java.io.IOException.class, () -> store.begin(rejectedId, 1000L));

        assertEquals("PENDING", store.statusOf(firstPendingId));
        assertEquals("", store.statusOf(rejectedId));
        assertEquals(256, store.status().pendingCount());
    }
}
