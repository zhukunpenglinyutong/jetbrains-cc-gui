package com.github.claudecodegui.storage;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;

import static org.junit.Assert.*;

public class CodexStorageInventoryTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void diskFilesAcrossProjectsAndArchivesDefineTheVisibleList() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("first", "/one", 100);
        f.thread("second", "/two", 100);
        f.rollout("first", null, false);
        f.rollout("archive-only", null, true);
        var inventory = new CodexStorageInventory(f.paths);
        var all = inventory.list(null, 1, null, null);
        assertEquals(2, all.get("total").getAsInt());
        assertTrue(all.get("complete").getAsBoolean());
        assertTrue(all.get("hasMore").getAsBoolean());
        var second = inventory.list(all.get("nextCursor").getAsString(), 100, null, null);
        assertEquals(1, second.getAsJsonArray("sessions").size());
        assertFalse(second.get("hasMore").getAsBoolean());
        var search = inventory.list(null, 50, "/two", null);
        assertEquals(0, search.get("total").getAsInt());
        assertTrue(inventory.snapshot().sessions().containsKey("second"));
        assertFalse(all.toString().contains("files"));
    }

    @Test public void contentIsReadOnDemandWithExplicitOversizedRecordTruncation() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("large", "/one", 300000);
        var page = new CodexStorageInventory(f.paths).content("large", null, 10);
        var record = page.getAsJsonArray("records").get(0).getAsJsonObject();
        assertTrue(record.get("truncated").getAsBoolean());
        assertTrue(record.get("text").getAsString().length() <= 32768);
    }

    @Test public void numberedPagesHaveNoOverlapAndRespectAllRequestedPageSizes() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        for (int index = 0; index < 26; index++) {
            f.rollout(String.format("paged-%02d", index), null, false);
        }
        var inventory = new CodexStorageInventory(f.paths);
        var ids = new java.util.HashSet<String>();
        for (int number = 1; number <= 3; number++) {
            var page = inventory.listPage(number, 10, "paged-", "recent", "all");
            assertEquals(number, page.get("page").getAsInt());
            assertEquals(10, page.get("pageSize").getAsInt());
            assertEquals(26, page.get("total").getAsInt());
            assertEquals(number < 3, page.get("hasMore").getAsBoolean());
            for (var row : page.getAsJsonArray("sessions")) {
                assertTrue("Pages must not overlap", ids.add(row.getAsJsonObject().get("sessionId").getAsString()));
            }
        }
        assertEquals(26, ids.size());
        for (int size : new int[] {10, 15, 20, 50, 100}) {
            var page = inventory.listPage(1, size, "paged-", "recent", "all");
            assertEquals(size, page.get("pageSize").getAsInt());
            assertEquals(Math.min(size, 26), page.getAsJsonArray("sessions").size());
        }
        assertEquals(0, inventory.listPage(2, 10, "missing", "recent", "all").get("total").getAsInt());
        assertEquals(0, inventory.listPage(2, 10, "paged-", "recent", "archived").get("total").getAsInt());
    }

    @Test public void deletingTheFinalPageFallsBackToTheLastRemainingPageAndThenTheEmptyFirstPage() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        for (int index = 0; index < 11; index++) {
            f.rollout(String.format("delete-%02d", index), null, false);
        }
        var inventory = new CodexStorageInventory(f.paths);
        var last = inventory.listPage(2, 10, "", "recent", "all");
        String id = last.getAsJsonArray("sessions").get(0).getAsJsonObject().get("sessionId").getAsString();
        for (var path : inventory.snapshot().sessions().get(id).files) {
            Files.delete(path);
        }
        var remaining = inventory.listPage(Integer.MAX_VALUE, 10, "", "recent", "all");
        assertEquals(1, remaining.get("page").getAsInt());
        assertEquals(10, remaining.getAsJsonArray("sessions").size());
        for (var entry : inventory.snapshot().sessions().values()) {
            for (var path : entry.files) {
                Files.delete(path);
            }
        }
        var empty = inventory.listPage(2, 10, "", "recent", "all");
        assertEquals(1, empty.get("page").getAsInt());
        assertEquals(0, empty.get("total").getAsInt());
        assertFalse(empty.get("hasMore").getAsBoolean());
    }

    @Test public void numberedPagingCapsLargeRequestsAndRejectsNonPositivePages() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        for (int index = 0; index < 105; index++) {
            f.rollout(String.format("limit-%03d", index), null, false);
        }
        var inventory = new CodexStorageInventory(f.paths);
        var first = inventory.listPage(1, Integer.MAX_VALUE, "", "recent", "all");
        assertEquals(100, first.get("pageSize").getAsInt());
        assertEquals(100, first.getAsJsonArray("sessions").size());
        assertEquals(5, inventory.listPage(2, 100, "", "recent", "all").getAsJsonArray("sessions").size());
        assertEquals("INVALID_STORAGE_REQUEST", assertThrows(java.io.IOException.class,
                () -> inventory.listPage(0, 10, "", "recent", "all")).getMessage());
        assertThrows(java.io.IOException.class, () -> inventory.listPage(-1, 10, "", "recent", "all"));
    }

    @Test public void emptyDatabaseProjectionFallsBackToExistingRolloutAndKeepsFilePagination() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("projected", "/project", 10);
        f.rollout("projected", null, false);
        f.sql("thread_history_1.sqlite", "DELETE FROM thread_items WHERE thread_id='projected'");
        var inventory = new CodexStorageInventory(f.paths);
        var first = inventory.content("projected", null, 1);
        assertEquals(1, first.getAsJsonArray("records").size());
        assertTrue(first.get("hasMore").getAsBoolean());
        assertTrue(first.get("nextCursor").getAsString().startsWith("file:"));
        var next = inventory.content("projected", first.get("nextCursor").getAsString(), 1);
        assertTrue(next.getAsJsonArray("records").get(0).getAsJsonObject().get("text").getAsString().contains("file history"));
        assertFalse(next.get("hasMore").getAsBoolean());
    }

    @Test public void usageReadsOnlyAttributesAndPreservesProtectedAssets() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        var protectedFile = Files.createDirectories(f.root.resolve("pets")).resolve("asset.txt");
        Files.writeString(protectedFile, "protected");
        var result = new CodexStorageInventory(f.paths).usage(() -> false);
        assertEquals(f.root.toRealPath().toString(), result.get("physicalRoot").getAsString());
        assertEquals(9L, result.getAsJsonObject("categories").get("protectedAssets").getAsLong());
        assertEquals("protected", Files.readString(protectedFile));
    }

    @Test public void schemaReadFailuresRetainAnActionableReasonAndDisableDeletion() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.rollout("readable", null, false);
        f.sql("state_5.sqlite", "DROP TABLE threads");
        var snapshot = new CodexStorageInventory(f.paths).snapshot();
        assertTrue(snapshot.errors().contains("state_5.sqlite: DATABASE_SCHEMA_UNSUPPORTED"));
        assertTrue(snapshot.sessions().get("readable").readable);
        assertEquals("INVENTORY_INCOMPLETE", snapshot.sessions().get("readable").deletionUnavailableReason);
    }

    @Test public void usageDeduplicatesHardLinksWithPhysicalIdentity() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        var file = f.rollout("linked", null, false);
        var inventory = new CodexStorageInventory(f.paths);
        long before = inventory.usage(() -> false).get("logicalBytes").getAsLong();
        Files.createLink(file.resolveSibling("another-link.jsonl"), file);
        assertEquals(before, inventory.usage(() -> false).get("logicalBytes").getAsLong());
    }

    @Test public void emptyRolloutDoesNotDisableOtherSessionsOrBecomeMissingHistory() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("readable", "/project", 10);
        f.rollout("readable", null, false);
        var directory = f.root.resolve("sessions");
        Files.createFile(directory.resolve("rollout-2026-10-09T09-46-04-00000000-0000-4000-8000-000000000001.jsonl"));
        var inventory = new CodexStorageInventory(f.paths);
        var page = inventory.list(null, 50, "", "recent", "all");
        assertEquals(2, page.get("total").getAsInt());
        assertTrue(page.get("complete").getAsBoolean());
        assertTrue(page.getAsJsonArray("errors").isEmpty());
        var snapshot = inventory.snapshot();
        assertNull(snapshot.sessions().get("readable").deletionUnavailableReason);
        assertNotNull(snapshot.sessions().get("00000000-0000-4000-8000-000000000001").metadataWarning);
        assertFalse(inventory.content("readable", null, 10).getAsJsonArray("records").isEmpty());
    }

    @Test public void injectedInstructionsAreSkippedWhenDerivingTheDisplayTitle() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("title", "/project", 10);
        f.sql("state_5.sqlite", "UPDATE threads SET title='<agents-instructions> # Global Instructions'");
        var file = f.rollout("title", null, false);
        Files.writeString(file, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"<agents-instructions>rules</agents-instructions>\"}}\n"
                + "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Fix the storage list\"}}\n", java.nio.file.StandardOpenOption.APPEND);
        assertEquals("Fix the storage list", new CodexStorageInventory(f.paths).snapshot().sessions().get("title").title);
    }

    @Test public void savedSessionTitlesOverrideRawPromptsBeforeSearchAndPagination() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("renamed", "/project", 10);
        f.sql("state_5.sqlite", "UPDATE threads SET title='Read a local CODEX session by ID'");
        f.rollout("renamed", null, false);
        f.rollout("archived-renamed", null, true);
        var titles = java.util.Map.of("renamed", "Pet 工作室优化", "archived-renamed", "Pet 场景设计", "missing", "Pet missing");
        var inventory = new CodexStorageInventory(f.paths, titles);

        var first = inventory.list(null, 1, "Pet", "size");
        assertEquals(2, first.get("total").getAsInt());
        assertTrue(first.get("hasMore").getAsBoolean());
        String firstId = first.getAsJsonArray("sessions").get(0).getAsJsonObject().get("sessionId").getAsString();
        assertEquals(titles.get(firstId), first.getAsJsonArray("sessions").get(0).getAsJsonObject().get("title").getAsString());
        var next = inventory.list(first.get("nextCursor").getAsString(), 1, "Pet", "size");
        String nextId = next.getAsJsonArray("sessions").get(0).getAsJsonObject().get("sessionId").getAsString();
        assertNotEquals(firstId, nextId);
        assertEquals(titles.get(nextId), next.getAsJsonArray("sessions").get(0).getAsJsonObject().get("title").getAsString());
        assertFalse(next.get("hasMore").getAsBoolean());
        assertEquals("Pet 场景设计", inventory.listPage(1, 10, "场景", "recent", "archived")
                .getAsJsonArray("sessions").get(0).getAsJsonObject().get("title").getAsString());
        assertEquals(0, inventory.list(null, 10, "Read a local CODEX", "recent").get("total").getAsInt());
        assertEquals(1, inventory.list(null, 10, "renamed", "recent", "archived").get("total").getAsInt());
    }

    @Test public void missingAndBlankSavedTitlesRetainExistingFallbacks() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("state-title", "/project", 10);
        f.rollout("state-title", null, false);
        var rollout = f.rollout("rollout-title", null, false);
        Files.writeString(rollout, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Original rollout request\"}}\n",
                java.nio.file.StandardOpenOption.APPEND);
        f.rollout("untitled", null, false);
        var titles = java.util.Map.of("state-title", "  ", "rollout-title", "\n");
        var snapshot = new CodexStorageInventory(f.paths, titles).snapshot();

        assertEquals("Title state-title", snapshot.sessions().get("state-title").title);
        assertEquals("Original rollout request", snapshot.sessions().get("rollout-title").title);
        assertEquals("untitled", snapshot.sessions().get("untitled").title);
        assertEquals(3, snapshot.sessions().size());
    }

    @Test public void anIdleClientsWriterLockIsNotReportedAsAnExecutingTurn() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("client-owned", "/project", 10);
        var directory = Files.createDirectory(f.root.resolve("thread-writer-locks"));
        try (var lock = CodexStorageFileLock.tryAcquire(f.paths, directory.resolve("client-owned.lock"), true)) {
            assertNotNull(lock);
            var snapshot = new CodexStorageInventory(f.paths).snapshot();
            assertTrue(snapshot.errors().isEmpty());
            var session = snapshot.sessions().get("client-owned");
            assertFalse(session.running);
            assertEquals("SESSION_WRITER_BUSY", session.deletionUnavailableReason);
            assertTrue(session.readable);
            assertEquals(0, new CodexStorageInventory(f.paths).list(null, 50, "", "recent", "idle").get("total").getAsInt());
            assertEquals(0, new CodexStorageInventory(f.paths).list(null, 50, "", "recent", "running").get("total").getAsInt());
            assertFalse(new CodexStorageInventory(f.paths).content("client-owned", null, 10).getAsJsonArray("records").isEmpty());
        }
    }

    @Test public void growingAnAlreadyNewestRolloutDoesNotInvalidateTheNextPage() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        var first = f.rollout("a-growing", null, false);
        f.rollout("b-older", null, false);
        Files.setLastModifiedTime(first, java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 10000));
        var inventory = new CodexStorageInventory(f.paths);
        var page = inventory.list(null, 1, "", "recent");
        assertEquals("a-growing", page.getAsJsonArray("sessions").get(0).getAsJsonObject().get("sessionId").getAsString());
        Files.writeString(first, "{\"type\":\"progress\"}\n", java.nio.file.StandardOpenOption.APPEND);
        var next = inventory.list(page.get("nextCursor").getAsString(), 1, "", "recent");
        assertEquals("b-older", next.getAsJsonArray("sessions").get(0).getAsJsonObject().get("sessionId").getAsString());
    }
}
