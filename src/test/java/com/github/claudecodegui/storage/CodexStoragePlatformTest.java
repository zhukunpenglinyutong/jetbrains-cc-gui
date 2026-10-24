package com.github.claudecodegui.storage;

import com.sun.jna.Platform;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.*;

/** Separates history deletion capability from advanced maintenance without file-only fallback. */
public class CodexStoragePlatformTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void rejectsRemoteAndUnknownPosixFilesystems() {
        for (String type : List.of("nfs", "nfs4", "cifs", "smbfs", "9p", "fuse", "unknown", "NTFS")) {
            assertFalse(type, CodexStoragePlatform.isLocalPosixStore(type));
        }
        for (String type : List.of("APFS", "hfs", "ext4", "xfs", "btrfs", "tmpfs", "overlay")) {
            assertTrue(type, CodexStoragePlatform.isLocalPosixStore(type));
        }
    }

    @Test public void ordinaryDeletionDoesNotInheritTheAdvancedMaintenanceRestriction() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 32);
        f.thread("keep", "/project", 32);
        var rollout = f.rollout("remove", null, false);
        var service = new CodexStorageMaintenance(f.paths, f.gate, f.coordination, path -> Long.MAX_VALUE, false, true, checkpoint -> { });
        assertEquals("MAINTENANCE_PLATFORM_UNSUPPORTED", service.databaseStatus().get("unavailableReason").getAsString());
        var admission = service.mutationStatus();
        assertFalse(admission.get("available").getAsBoolean());
        assertEquals("MAINTENANCE_PLATFORM_UNSUPPORTED", admission.get("unavailableReason").getAsString());
        assertTrue(admission.get("deletionAvailable").getAsBoolean());
        assertFalse(admission.has("deletionUnavailableReason"));
        assertCompletedDeletion(service.deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false), "remove");
        assertFalse(Files.exists(rollout));
        assertFalse(new CodexStorageInventory(f.paths).snapshot().sessions().containsKey("remove"));
        assertTrue(new CodexStorageInventory(f.paths).snapshot().sessions().containsKey("keep"));
        IOException compact = assertThrows(IOException.class,
                () -> service.compact(service.databaseStatus().get("databaseId").getAsString(), UUID.randomUUID().toString()));
        assertEquals("MAINTENANCE_PLATFORM_UNSUPPORTED", compact.getMessage());
    }

    @Test public void productionCapabilitiesAgreeWithTheInventoryAndSupportThisLocalFixture() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 16);
        var rollout = f.rollout("remove", null, false);
        boolean supported = CodexStoragePlatform.supportsDeletion(f.paths);
        var row = new CodexStorageInventory(f.paths).snapshot().sessions().get("remove");
        assertEquals(supported, row.deletionUnavailableReason == null);
        var service = new CodexStorageMaintenance(f.paths, f.gate, f.coordination, path -> Long.MAX_VALUE,
                CodexStoragePlatform.supportsMaintenance(f.paths), supported, checkpoint -> { });
        if (supported) {
            assertCompletedDeletion(service.deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false), "remove");
            assertFalse(Files.exists(rollout));
        } else {
            assertThrows(IOException.class, () -> service.deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false));
            assertTrue(Files.exists(rollout));
        }
        if (Platform.isLinux() || Platform.isMac()) {
            assertFalse(CodexStoragePlatform.supportsMaintenance(f.paths));
        }
    }

    @Test public void unsupportedDeletionLeavesBothRolloutAndDatabaseUntouched() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 16);
        var rollout = f.rollout("remove", null, false);
        var service = new CodexStorageMaintenance(f.paths, f.gate, f.coordination, path -> Long.MAX_VALUE, false, false, checkpoint -> { });
        assertFalse(service.mutationStatus().get("deletionAvailable").getAsBoolean());
        assertEquals("MAINTENANCE_PLATFORM_UNSUPPORTED", service.mutationStatus().get("deletionUnavailableReason").getAsString());
        assertEquals("MAINTENANCE_PLATFORM_UNSUPPORTED", assertThrows(IOException.class,
                () -> service.deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false)).getMessage());
        assertTrue(Files.exists(rollout));
        assertTrue(new CodexStorageInventory(f.paths).snapshot().sessions().containsKey("remove"));
    }

    @Test public void physicalIdentityDoesNotChangeWhenNativeDirectoriesOrDatabaseContentsChange() throws Exception {
        var root = temporary.newFolder().toPath().toRealPath();
        var paths = new CodexStoragePaths(root);
        var file = Files.writeString(root.resolve("fixture.sqlite"), "before");
        String identity = CodexStoragePaths.identity(file);
        Files.createDirectory(root.resolve("thread-writer-locks"));
        Files.writeString(file, "after");
        var changed = java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 20000);
        Files.setLastModifiedTime(root, changed);
        Files.setLastModifiedTime(file, changed);
        paths.revalidate();
        assertEquals(identity, CodexStoragePaths.identity(file));
    }

    private static void assertCompletedDeletion(com.google.gson.JsonObject status, String id) {
        assertEquals(status.toString(), "COMPLETED", status.get("state").getAsString());
        assertEquals(id, status.getAsJsonObject("result").getAsJsonArray("deletedSessionIds").get(0).getAsString());
    }
}
