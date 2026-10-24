package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.*;

public class PetOfficeModeStoreTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void everyLiveMemberMustAcknowledgeTheExactTransitionBeforeOfficeCanRender() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficeModeStore(root);
        var a = PetOfficeTestRoot.member(); var b = PetOfficeTestRoot.member();
        store.register(a); store.register(b);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var entering = store.beginEnter("owner", lease);
            assertEquals(PetOfficeModeStore.Mode.ENTERING_OFFICE, store.read().mode());
            assertEquals(2, entering.participants().size());
            assertFalse(store.commitOffice(entering, lease));
            store.register(ack(a, entering.epoch())); assertFalse(store.commitOffice(entering, lease));
            store.register(ack(b, entering.epoch())); assertTrue(store.commitOffice(entering, lease));
            assertEquals(PetOfficeModeStore.Mode.OFFICE, store.read().mode());
        }
    }

    @Test public void staleAcknowledgementsCannotAuthorizeANewLeaderAndHideDoesNotExitDisplayMode() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficeModeStore(root); var member = PetOfficeTestRoot.member();
        store.register(member);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var first = store.beginEnter("first", lease); store.register(ack(member, first.epoch())); assertTrue(store.commitOffice(first, lease));
            var recovery = new PetOfficeRecoveryStore(root); recovery.adopt("first", null, true, lease); recovery.write("first", true, false, lease);
            assertEquals(PetOfficeModeStore.Mode.OFFICE, store.read().mode());
            var next = store.beginEnter("next", lease); assertFalse(store.commitOffice(next, lease));
            assertThrows(IOException.class, () -> store.commitOffice(first, lease));
            store.register(ack(member, next.epoch())); assertTrue(store.commitOffice(next, lease));
        }
    }

    @Test public void aMissingMarkerForAStillLiveProcessNeverCountsAsDetachment() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficeModeStore(root); var member = PetOfficeTestRoot.member();
        store.register(member);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var entering = store.beginEnter("owner", lease); store.unregister(member);
            assertFalse(store.commitOffice(entering, lease));
            var joined = PetOfficeTestRoot.member(); store.register(joined);
            assertEquals(PetOfficeModeStore.Mode.ENTERING_OFFICE, store.read().mode());
            assertFalse(store.commitOffice(entering, lease));
        }
    }

    @Test public void processIdentityRatherThanHeartbeatAgeRemovesADeadOrReusedPidMarker() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficeModeStore(root); var old = PetOfficeTestRoot.member();
        var stale = new PetOfficeModeStore.Member(old.id(), old.pid(), old.startedAt() + 1, "old"); store.register(stale);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var entering = store.beginEnter("owner", lease); assertTrue(entering.participants().isEmpty());
            assertTrue(store.commitOffice(entering, lease));
            assertFalse(Files.exists(root.resolve(PetOfficeEndpointStore.memberName(stale.id()))));
        }
    }

    @Test public void overlayPermissionFollowsDisposalCommitAndAnOldLeaseCannotRestoreIt() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficeModeStore(root);
        var oldLease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow();
        try (oldLease) {
            var entering = store.beginEnter("owner", oldLease); assertTrue(store.commitOffice(entering, oldLease));
            store.beginExit("owner", oldLease); assertEquals(PetOfficeModeStore.Mode.EXITING_OFFICE, store.read().mode());
            assertFalse(PetOfficeRuntimeLease.tryAcquire(root).isPresent());
        }
        assertThrows(IOException.class, () -> store.commitOverlay(oldLease));
        try (var administrative = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            new PetOfficeRecoveryStore(root).disable(administrative); store.commitOverlay(administrative);
            assertEquals(PetOfficeModeStore.Mode.IDE_OVERLAY, store.read().mode());
            assertFalse(new PetOfficeRecoveryStore(root).read().enabled());
            assertFalse(Files.exists(root.resolve("coordinator-v1.json")));
        }
    }

    @Test public void unknownControlSchemaIsNeverSilentlyReplacedByEntryOrAdministrativeExit() throws Exception {
        var root = PetOfficeTestRoot.create(temporary); var store = new PetOfficeModeStore(root);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            JsonObject invalid = new JsonObject(); invalid.addProperty("schemaVersion", 99);
            new PetOfficeEndpointStore(root).writePrivate(PetOfficeModeStore.FILE, invalid, lease);
            byte[] before = Files.readAllBytes(root.resolve(PetOfficeModeStore.FILE));
            assertThrows(IOException.class, store::read);
            assertThrows(IOException.class, () -> store.beginEnter("owner", lease));
            assertThrows(IOException.class, () -> store.commitOverlay(lease));
            assertArrayEquals(before, Files.readAllBytes(root.resolve(PetOfficeModeStore.FILE)));
        }
    }

    private static PetOfficeModeStore.Member ack(PetOfficeModeStore.Member member, String epoch) {
        return new PetOfficeModeStore.Member(member.id(), member.pid(), member.startedAt(), epoch);
    }
    @Test public void aConfirmedDetachRetiresALiveProcessEvenFromAnInFlightEntrySnapshot() throws Exception {
        Path root = PetOfficeTestRoot.create(temporary);
        var store = new PetOfficeModeStore(root); var member = PetOfficeTestRoot.member(); store.register(member);
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var entering = store.beginEnter("leader", lease);
            assertFalse(store.commitOffice(entering, lease));
            store.retire(member);
            assertTrue(store.commitOffice(entering, lease));
            assertTrue(store.beginEnter("next", lease).participants().isEmpty());
        }
    }
}
