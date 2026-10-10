package com.github.claudecodegui.clawbot;

import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import static org.junit.Assert.*;

public class ClawBotOutboundProtectionTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void archivedUnknownDoesNotExhaustActiveQueueAndBatchAdmissionIsAtomic() throws Exception {
        var store = new ClawBotPendingDeliveryStore(folder.newFolder().toPath());
        var archived = new java.util.ArrayList<ClawBotPendingDeliveryStore.Delivery>();
        for (int i = 0; i < 256; i++) {
            archived.add(new ClawBotPendingDeliveryStore.Delivery("unknown-" + i, "sender", "context", "body", true, null, true));
        }
        store.putAll(archived, "key");
        var active = new java.util.ArrayList<ClawBotPendingDeliveryStore.Delivery>();
        for (int i = 0; i < 255; i++) {
            active.add(new ClawBotPendingDeliveryStore.Delivery("active-" + i, "sender", "context", "body", true, null));
        }
        store.putAll(active, "key");
        var first = new ClawBotPendingDeliveryStore.Delivery("part-one", "sender", "context", "first", true, null);
        var second = new ClawBotPendingDeliveryStore.Delivery("part-two", "sender", "context", "second", true, "part-one");
        assertThrows(java.io.IOException.class, () -> store.putAll(java.util.List.of(first, second), "key"));
        assertFalse(store.pending("key").stream().anyMatch(value -> value.id().equals("part-one")));
        store.put(first, "key");
        assertEquals(512, store.pending("key").size());
        store.removeRecipient("sender", "key");
        assertTrue(store.pending("key").isEmpty());
    }

    @Test
    public void ordinaryTrafficCannotSpendLifecycleReserveAndRestartRetainsWindow() throws Exception {
        Path directory = folder.newFolder().toPath();
        ClawBotOutboundProtection protection = new ClawBotOutboundProtection(directory);
        for (int i = 0; i < 4; i++) {
            assertTrue(protection.acquire(1_000L, true));
        }
        assertFalse(protection.acquire(1_000L, true));
        assertTrue(protection.acquire(1_000L, false));
        assertTrue(protection.acquire(1_000L, false));
        ClawBotOutboundProtection restarted = new ClawBotOutboundProtection(directory);
        assertFalse(restarted.acquire(1_000L, false));
        assertEquals(301_000L, restarted.nextAllowedAt(1_000L));
        assertTrue(restarted.acquire(301_000L, false));
    }

    @Test
    public void explicitCooldownSurvivesRestartAndCannotBeBypassedByCriticalMessages() throws Exception {
        Path directory = folder.newFolder().toPath();
        ClawBotOutboundProtection protection = new ClawBotOutboundProtection(directory);
        protection.coolDown(5_000L);
        ClawBotOutboundProtection restarted = new ClawBotOutboundProtection(directory);
        assertFalse(restarted.acquire(304_999L, false));
        assertTrue(restarted.acquire(305_000L, false));
    }

    @Test
    public void queuedMessagesAreEncryptedRecoverableAndIdempotent() throws Exception {
        Path directory = folder.newFolder().toPath();
        ClawBotPendingDeliveryStore store = new ClawBotPendingDeliveryStore(directory);
        String id = UUID.randomUUID().toString();
        var delivery = new ClawBotPendingDeliveryStore.Delivery(id, "recipient", "private-context", "private-response", true, null);
        store.put(delivery, "fixture-key");
        store.put(delivery, "fixture-key");
        assertEquals(1, store.pending("fixture-key").size());
        byte[] encrypted = Files.readAllBytes(directory.resolve("pending-deliveries.enc"));
        assertFalse(new String(encrypted, java.nio.charset.StandardCharsets.ISO_8859_1).contains("private-response"));
        var restarted = new ClawBotPendingDeliveryStore(directory);
        assertEquals(delivery, restarted.pending("fixture-key").get(0));
        assertThrows(java.io.IOException.class, () -> new ClawBotPendingDeliveryStore(directory).pending("wrong-key"));
        restarted.markUnknown(id, "fixture-key");
        assertTrue(new ClawBotPendingDeliveryStore(directory).pending("fixture-key").get(0).unknown());
        restarted.remove(id, "fixture-key");
        assertTrue(new ClawBotPendingDeliveryStore(directory).pending("fixture-key").isEmpty());
    }

    @Test
    public void splitsLongFinalWithoutDroppingTextOrBreakingSurrogatePairs() {
        String text = "x".repeat(3999) + "\uD83D\uDE80" + "y".repeat(8001);
        var chunks = ClawBotGatewayRuntimeService.splitDeliveryText(text);
        assertEquals(text, String.join("", chunks));
        for (String chunk : chunks) {
            assertTrue(chunk.length() <= 4000);
            assertFalse(Character.isHighSurrogate(chunk.charAt(chunk.length() - 1)));
            assertFalse(Character.isLowSurrogate(chunk.charAt(0)));
        }
    }

    @Test
    public void legacySettingsMigrateAndUpdatesRejectUnsafeValues() throws Exception {
        var json = JsonParser.parseString("{\"textIntervalMinutes\":1,\"idleReminderMinutes\":1,"
                + "\"waitReminderMinutes\":1,\"maxNotifications\":100,\"excerptMaxCharacters\":4000,\"initialCheckDelaySeconds\":1}").getAsJsonObject();
        ClawBotProgressSettings migrated = ClawBotProgressSettings.fromJson(json);
        assertEquals(6, migrated.maxNotifications());
        assertEquals(3500, migrated.excerptMaxCharacters());
        assertEquals(15, migrated.initialCheckDelaySeconds());
        assertEquals(5, migrated.idleReminderMinutes());
        assertEquals(10, migrated.waitReminderMinutes());
        assertThrows(java.io.IOException.class, () -> ClawBotProgressSettings.fromUpdatePayload(json));
        var disabled = migrated.toJson();
        disabled.addProperty("maxNotifications", 0);
        disabled.addProperty("idleReminderMinutes", 0);
        disabled.addProperty("waitReminderMinutes", 0);
        assertEquals(0, ClawBotProgressSettings.fromUpdatePayload(disabled).maxNotifications());
    }
}
