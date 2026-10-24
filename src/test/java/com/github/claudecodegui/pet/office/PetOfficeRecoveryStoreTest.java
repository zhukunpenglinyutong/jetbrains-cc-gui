package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.util.EnumSet;
import java.util.List;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

public class PetOfficeRecoveryStoreTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void onlyExplicitOptInEnablesRecoveryAndHiddenIntentSurvivesOwnershipChange() throws Exception {
        Path root = privateRoot(); var store = new PetOfficeRecoveryStore(root);
        assertNull(store.read());
        PetOfficeRecoveryStore.Intent hidden;
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            assertThrows(IOException.class, () -> store.adopt("leader-A", null, false, lease));
            assertTrue(store.adopt("leader-A", null, true, lease).visible());
            hidden = store.write("leader-A", true, false, lease);
            assertFalse(hidden.visible());
            assertThrows(IOException.class, () -> store.write("different-leader", false, false, lease));
        }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var recovered = store.adopt("leader-B", hidden, false, lease);
            assertTrue(recovered.enabled()); assertFalse(recovered.visible());
            assertNotEquals(hidden.revision(), recovered.revision());
            assertEquals("leader-B", recovered.leaderEpoch());
        }
    }

    @Test
    public void explicitCloseAndAStaleCandidateCannotReenableTheOffice() throws Exception {
        Path root = privateRoot(); var store = new PetOfficeRecoveryStore(root);
        PetOfficeRecoveryStore.Intent enabled;
        PetOfficeRecoveryStore.Intent disabled;
        var oldLease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow();
        try (oldLease) {
            enabled = store.adopt("leader-A", null, true, oldLease);
            disabled = store.write("leader-A", false, false, oldLease);
        }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            assertThrows(IOException.class, () -> store.adopt("leader-B", enabled, false, lease));
            assertThrows(IOException.class, () -> store.adopt("leader-B", disabled, false, lease));
            assertThrows(IOException.class, () -> store.write("leader-A", true, true, oldLease));
            assertEquals(disabled, store.read());
            assertTrue(store.adopt("leader-B", disabled, true, lease).visible());
        }
    }

    @Test
    public void unknownCorruptAndForeignReadableIntentFailsClosedWithoutBeingReplaced() throws Exception {
        Path root = privateRoot(); var store = new PetOfficeRecoveryStore(root);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            store.adopt("leader", null, true, lease);
            Path file = root.resolve(PetOfficeRecoveryStore.FILE);
            JsonObject unknown = new JsonObject(); unknown.addProperty("schemaVersion", 99);
            new PetOfficeEndpointStore(root).writePrivate(PetOfficeRecoveryStore.FILE, unknown, lease);
            byte[] before = Files.readAllBytes(file);
            assertThrows(IOException.class, store::read);
            assertThrows(IOException.class, () -> store.adopt("next", null, true, lease));
            assertArrayEquals(before, Files.readAllBytes(file));
            Files.delete(file);
            store.adopt("leader", null, true, lease);
            var acl = Files.getFileAttributeView(file, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
            var original = acl.getAcl();
            var system = file.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName("NT AUTHORITY\\SYSTEM");
            acl.setAcl(List.of(original.get(0), AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(system)
                    .setPermissions(AclEntryPermission.READ_DATA).build()));
            try {
                assertThrows(IOException.class, store::read);
            } finally {
                acl.setAcl(original);
            }
        }
    }

    @Test
    public void protocolUpgradeRetainsTheSameEndpointAndLockPathsAndRejectsOldSchemas() throws Exception {
        Path root = privateRoot(); var endpoints = new PetOfficeEndpointStore(root);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var endpoint = new PetOfficeEndpointStore.Endpoint(4321, "leader", "a".repeat(64), "owner");
            endpoints.publish(endpoint, lease);
            assertTrue(Files.exists(root.resolve("coordinator-v1.json")));
            JsonObject value = endpoints.readPrivate("coordinator-v1.json"); value.addProperty("schemaVersion", 1);
            endpoints.writePrivate("coordinator-v1.json", value, lease);
            assertThrows(IOException.class, endpoints::read);
            assertFalse(PetOfficeRuntimeLease.tryAcquire(root).isPresent());
        }
    }

    private Path privateRoot() throws Exception {
        assumeTrue(System.getProperty("os.name").startsWith("Windows"));
        Path root = temporary.newFolder().toPath();
        var owner = Files.getOwner(root, LinkOption.NOFOLLOW_LINKS);
        Files.getFileAttributeView(root, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS)
                .setAcl(List.of(AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(owner)
                        .setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)
                        .setPermissions(EnumSet.allOf(AclEntryPermission.class)).build()));
        return root;
    }
}
