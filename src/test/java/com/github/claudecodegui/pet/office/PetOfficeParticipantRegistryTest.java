package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.*;

public class PetOfficeParticipantRegistryTest {
    private final AtomicLong now = new AtomicLong(TimeUnit.SECONDS.toNanos(1));
    private final PetOfficeParticipantRegistry registry = new PetOfficeParticipantRegistry(Clock.systemUTC(), now::get);

    @Test
    public void fullSnapshotsPreserveProductProjectAndBindingIdentityAcrossParticipants() throws Exception {
        var idea = registry.connect("idea", "idea-epoch");
        var pycharm = registry.connect("pycharm", "pycharm-epoch");
        registry.commit(idea, PetOfficeParticipantFixture.bytes(idea, 1, 1, 1), 0);
        registry.commit(pycharm, PetOfficeParticipantFixture.bytes(pycharm, 1, 1, 1), 0);
        var view = registry.view("idea", "leader");
        assertEquals(2, view.snapshot().sources().size());
        assertEquals(java.util.List.of("idea", "pycharm"), view.participants());
        assertNotEquals(view.snapshot().sources().get(0).sourceKey(), view.snapshot().sources().get(1).sourceKey());
        assertEquals("project pycharm", view.snapshot().sources().get(1).metadata().projectLabel());
    }

    @Test
    public void malformedForeignAndRegressedSnapshotsCannotReplaceTheLastCompleteSet() throws Exception {
        var connection = registry.connect("idea", "epoch");
        registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 2, 2, 2), 0);
        JsonObject invalid = PetOfficeIpcFrameCodec.parse(PetOfficeParticipantFixture.bytes(connection, 3, 3, 3));
        invalid.addProperty("sessionId", "unregistered");
        assertThrows(IOException.class, () -> registry.commit(connection, invalid.toString().getBytes(StandardCharsets.UTF_8), 0));
        byte[] foreign = PetOfficeParticipantSnapshotCodec.encode(PetOfficeParticipantFixture.snapshot("other", 3, 3, 3), connection.epoch());
        assertThrows(IOException.class, () -> registry.commit(connection, foreign, 0));
        assertThrows(IOException.class, () -> registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 1, 2, 2), 0));
        assertThrows(IOException.class, () -> registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 1, 3, 1), 0));
        assertEquals(2, registry.view("idea", "leader").snapshot().sources().size());
    }

    @Test
    public void heartbeatsKeepTransportAliveWithoutRenewingCachedWork() throws Exception {
        var connection = registry.connect("idea", "epoch");
        registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 1, 1, 1), 0);
        for (int i = 0; i < 9; i++) {
            advance(2000);
            registry.heartbeat(connection);
        }
        var source = registry.view("idea", "leader").snapshot().sources().get(0);
        assertEquals(SessionExecutionState.Phase.UNKNOWN, source.execution().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, source.execution().outcome());
        assertEquals(18_000, source.observationAgeMillis());
        assertEquals(PetOfficeSessionRegistry.RouteStatus.AVAILABLE, source.routeStatus());
    }

    @Test
    public void anAdvancedSnapshotWatermarkAloneCannotRefreshAnUnchangedObservation() throws Exception {
        var connection = registry.connect("idea", "epoch");
        registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 1, 1, 1), 0);
        advance(12_000);
        registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 1, 2, 1), 0);
        advance(4000);
        assertEquals(SessionExecutionState.Phase.UNKNOWN, registry.view("idea", "leader").snapshot().sources().get(0).execution().phase());
        registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 1, 3, 2), 0);
        assertEquals(SessionExecutionState.Phase.RUNNING, registry.view("idea", "leader").snapshot().sources().get(0).execution().phase());
    }

    @Test
    public void anOldDisconnectOrCallbackCannotEraseTheReconnectedOwner() throws Exception {
        var old = registry.connect("idea", "old");
        registry.commit(old, PetOfficeParticipantFixture.bytes(old, 1, 1, 1), 0);
        var latest = registry.connect("idea", "new");
        assertEquals(SessionExecutionState.Phase.UNKNOWN, registry.view("idea", "leader").snapshot().sources().get(0).execution().phase());
        registry.commit(latest, PetOfficeParticipantFixture.bytes(latest, 2, 2, 2), 0);
        registry.disconnect(old);
        assertThrows(IOException.class, () -> registry.heartbeat(old));
        assertThrows(IOException.class, () -> registry.commit(old, PetOfficeParticipantFixture.bytes(old, 3, 3, 3), 0));
        assertEquals(2, registry.view("idea", "leader").snapshot().sources().size());
        assertEquals(SessionExecutionState.Phase.RUNNING, registry.view("idea", "leader").snapshot().sources().get(0).execution().phase());
    }

    @Test
    public void disconnectedSourcesBecomeUnknownAndRetireWithoutInventingAResult() throws Exception {
        var connection = registry.connect("idea", "epoch");
        registry.commit(connection, PetOfficeParticipantFixture.bytes(connection, 1, 1, 1), 0);
        registry.disconnect(connection);
        var source = registry.view("idea", "leader").snapshot().sources().get(0);
        assertEquals(SessionExecutionState.Phase.UNKNOWN, source.execution().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, source.execution().outcome());
        assertEquals(PetOfficeSessionRegistry.RouteStatus.DETACHED, source.routeStatus());
        advance(29_999);
        assertEquals(1, registry.view("idea", "leader").snapshot().sources().size());
        advance(1);
        assertTrue(registry.view("idea", "leader").snapshot().sources().isEmpty());
    }

    @Test
    public void groupCapacityRejectsAtomicallyAndRemainsVisibleAfterTheRejectedSocketCloses() throws Exception {
        var idea = registry.connect("idea", "epoch");
        var pycharm = registry.connect("pycharm", "epoch");
        registry.commit(idea, PetOfficeParticipantFixture.bytes(idea, 200, 1, 1), 0);
        registry.commit(pycharm, PetOfficeParticipantFixture.bytes(pycharm, 56, 1, 1), 0);
        assertThrows(IOException.class, () -> registry.commit(pycharm, PetOfficeParticipantFixture.bytes(pycharm, 57, 2, 2), 0));
        assertEquals(256, registry.view("idea", "leader").snapshot().sources().size());
        assertTrue(registry.view("idea", "leader").snapshot().capacityReached());
        var newcomer = registry.connect("webstorm", "epoch");
        assertThrows(IOException.class, () -> registry.commit(newcomer, PetOfficeParticipantFixture.bytes(newcomer, 1, 1, 1), 0));
        registry.disconnect(newcomer);
        assertTrue(registry.view("idea", "leader").snapshot().capacityReached());
    }

    @Test
    public void ownerAdmissionRemainsReservedEvenAfterItsEmptyStreamRetires() throws Exception {
        registry.bindOwner("owner");
        var owner = registry.connect("owner", "epoch");
        registry.disconnect(owner);
        for (int i = 0; i < 15; i++) {
            registry.connect("peer-" + i, "epoch");
        }
        assertThrows(IOException.class, () -> registry.connect("peer-extra", "epoch"));
        registry.connect("owner", "new");
        assertEquals(16, registry.view("owner", "leader").participants().size());
    }

    @Test
    public void captureAndTransferAgesCountAgainstFreshnessAndWatermarksMustAgree() throws Exception {
        var connection = registry.connect("idea", "epoch");
        var bytes = PetOfficeParticipantFixture.bytes(connection, 1, 1, 1);
        assertThrows(IOException.class, () -> registry.commit(connection, bytes, 0, 2));
        assertThrows(IOException.class, () -> registry.commit(connection, bytes, 10_001));
        registry.commit(connection, bytes, 9000, 1);
        advance(6000);
        registry.heartbeat(connection);
        assertEquals(15_000, registry.view("idea", "leader").snapshot().sources().get(0).observationAgeMillis());
        assertEquals(SessionExecutionState.Phase.UNKNOWN, registry.view("idea", "leader").snapshot().sources().get(0).execution().phase());
    }

    private void advance(long millis) {
        now.addAndGet(TimeUnit.MILLISECONDS.toNanos(millis));
    }
}
