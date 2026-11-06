package com.github.claudecodegui.clawbot;

import com.google.gson.JsonParser;
import org.junit.Test;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.*;

public class ClawBotContractBoundaryTest {
    @Test
    public void ownershipNumbersRejectCoercionFractionsAndOverflow() throws Exception {
        var registration = ClawBotSessionWireCodec.registrationToJson(registration("session", "idea"));
        var target = new ClawBotSessionTarget("session", "idea", 1, "codex", "generation").toJson();
        var inbound = new ClawBotInboundMessage("message", "user", "context", "hello").toJson();
        for (String invalid : List.of("1.9", "\"1\"", "true", "null", "-1", "9223372036854775808", "1e1000")) {
            registration.add("connectionEpoch", JsonParser.parseString(invalid));
            target.add("connectionEpoch", JsonParser.parseString(invalid));
            inbound.add("routeRevision", JsonParser.parseString(invalid));
            assertThrows(IOException.class, () -> ClawBotSessionWireCodec.registrationFromJson(registration));
            assertThrows(IllegalArgumentException.class, () -> ClawBotSessionTarget.fromJson(target));
            assertThrows(IllegalArgumentException.class, () -> ClawBotInboundMessage.fromJson(inbound));
        }
        registration.addProperty("connectionEpoch", 7);
        assertEquals(7, ClawBotSessionWireCodec.registrationFromJson(registration).connectionEpoch());
    }

    @Test
    public void admissionAndReplacementRemainBoundedAndAtomic() {
        var registry = new ClawBotSessionRegistry();
        for (int i = 0; i < 256; i++) {
            assertTrue(registry.register(registration("session-" + i, "idea")));
        }
        var before = registry.snapshot();
        assertFalse(registry.register(registration("overflow", "pycharm")));
        assertFalse(registry.replaceSnapshot("pycharm", 1, List.of(registration("overflow", "pycharm"))));
        assertEquals(before.stream().map(ClawBotSessionSnapshot::sessionHandleId).toList(),
                registry.snapshot().stream().map(ClawBotSessionSnapshot::sessionHandleId).toList());
        assertFalse(registry.replaceSnapshot("idea", 1,
                List.of(registration("session-0", "idea"), registration("session-0", "idea"))));
        assertEquals(256, registry.snapshot().size());
        assertTrue(registry.unregister("session-0", "idea", 1));
        assertTrue(registry.register(registration("replacement", "pycharm")));
        assertEquals(256, registry.snapshot().size());
    }

    @Test
    public void immutableSnapshotsCopyAndValidateMetadata() {
        var capabilities = new HashSet<>(Set.of("STATUS"));
        var snapshot = new ClawBotSessionSnapshot("session", "idea", "project", "Project", "codex", capabilities,
                ClawBotSessionStatus.ONLINE, 1, 1, 1);
        capabilities.clear();
        assertEquals(Set.of("STATUS"), snapshot.capabilities());
        assertThrows(UnsupportedOperationException.class, () -> snapshot.capabilities().clear());
        assertThrows(IllegalArgumentException.class, () -> new ClawBotSessionSnapshot("session", "idea", "project", "Project", "codex",
                Set.of(), ClawBotSessionStatus.ONLINE, 1, -1, 1));
    }

    private static ClawBotSessionRegistration registration(String handle, String owner) {
        return new ClawBotSessionRegistration(handle, owner, "project", "Project", "codex", Set.of("STATUS", "INBOUND"),
                ClawBotSessionStatus.ONLINE, 1, "Chat", "generation");
    }
}
