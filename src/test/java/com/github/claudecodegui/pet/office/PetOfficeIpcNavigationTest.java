package com.github.claudecodegui.pet.office;

import org.junit.Test;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.*;

public class PetOfficeIpcNavigationTest {
    @Test
    public void authenticatedPublishingStreamsCarryOnlyTargetedNavigationAndCorrelatedResults() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        List<PetOfficeTabNavigator.Result> results = new CopyOnWriteArrayList<>();
        try (var server = new PetOfficeIpcServer("owner", registry, () -> true, () -> { });
             var idea = new PetOfficeIpcClient(server.endpoint(), "idea");
             var pycharm = new PetOfficeIpcClient(server.endpoint(), "pycharm")) {
            idea.publish(PetOfficeParticipantFixture.snapshot("idea", 1, 1, 1));
            pycharm.publish(PetOfficeParticipantFixture.snapshot("pycharm", 1, 1, 1));
            var request = new PetOfficeTabNavigator.Request(UUID.randomUUID().toString(), "pycharm/tab-0/binding-0", "route-0", "question-1");
            server.routes().submit("page", request, () -> true, results::add, System.nanoTime());
            assertTrue(idea.poll().isEmpty());
            var command = pycharm.poll().get(0);
            assertEquals(request, command.request()); assertTrue(pycharm.poll().isEmpty());
            idea.complete(command, PetOfficeTabNavigator.Result.ACTIVATED); assertTrue(results.isEmpty());
            pycharm.complete(command, PetOfficeTabNavigator.Result.STALE_INTERACTION);
            pycharm.complete(command, PetOfficeTabNavigator.Result.ACTIVATED);
            assertEquals(List.of(PetOfficeTabNavigator.Result.STALE_INTERACTION), results);
        }
    }

    @Test
    public void ownerLossClosesCommandStreamsAndDoesNotReplayInANewEpoch() throws Exception {
        var registry = new PetOfficeParticipantRegistry();
        AtomicBoolean owns = new AtomicBoolean(true);
        try (var server = new PetOfficeIpcServer("owner", registry, owns::get, () -> { });
             var pycharm = new PetOfficeIpcClient(server.endpoint(), "pycharm")) {
            pycharm.publish(PetOfficeParticipantFixture.snapshot("pycharm", 1, 1, 1));
            server.routes().submit("page", new PetOfficeTabNavigator.Request(UUID.randomUUID().toString(), "pycharm/tab-0/binding-0", "route-0", ""),
                    () -> true, ignored -> fail("Obsolete epoch must not report success"), System.nanoTime());
            owns.set(false);
            assertThrows(java.io.IOException.class, pycharm::poll);
            assertTrue(pycharm.isClosed());
            try (var replacement = new PetOfficeIpcServer("next-owner", new PetOfficeParticipantRegistry(), () -> true, () -> { });
                 var reconnected = new PetOfficeIpcClient(replacement.endpoint(), "pycharm")) {
                assertNotEquals(server.endpoint().leaderEpoch(), replacement.endpoint().leaderEpoch());
                reconnected.publish(PetOfficeParticipantFixture.snapshot("pycharm", 1, 2, 2));
                assertTrue(reconnected.poll().isEmpty());
            }
        }
    }
}
