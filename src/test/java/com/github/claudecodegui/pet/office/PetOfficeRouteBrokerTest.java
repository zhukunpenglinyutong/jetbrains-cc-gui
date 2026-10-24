package com.github.claudecodegui.pet.office;

import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.*;

public class PetOfficeRouteBrokerTest {
    private final AtomicLong time = new AtomicLong();
    private final AtomicBoolean owns = new AtomicBoolean(true);
    private final AtomicBoolean page = new AtomicBoolean(true);
    private final List<PetOfficeTabNavigator.Result> results = new ArrayList<>();
    private PetOfficeParticipantRegistry registry;
    private PetOfficeParticipantRegistry.Connection target;
    private PetOfficeRouteBroker broker;

    @Before
    public void setUp() throws Exception {
        registry = new PetOfficeParticipantRegistry(Clock.systemUTC(), time::get);
        target = registry.connect("pycharm", "connection");
        registry.commit(target, PetOfficeParticipantFixture.bytes(target, 1, 1, 1), 0);
        broker = new PetOfficeRouteBroker(registry, owns::get, time::get);
    }

    private PetOfficeTabNavigator.Request request() {
        return new PetOfficeTabNavigator.Request(UUID.randomUUID().toString(), "pycharm/tab-0/binding-0", "route-0", "");
    }

    private void submit(PetOfficeTabNavigator.Request request) {
        broker.submit("page", request, page::get, results::add, time.get());
    }

    @Test
    public void onlyTheExactTargetConnectionCanTakeAndCompleteARequest() throws Exception {
        var request = request(); submit(request);
        var other = registry.connect("webstorm", "connection-other");
        assertTrue(broker.poll(other).isEmpty());
        var command = broker.poll(target).get(0);
        assertEquals(request, command.request());
        assertTrue(broker.poll(target).isEmpty());
        var reply = new PetOfficeRouteBroker.Reply(request.requestId(), command.ticket(), PetOfficeTabNavigator.Result.ATTENTION_REQUESTED);
        broker.complete(other, reply); assertTrue(results.isEmpty());
        broker.complete(target, reply); broker.complete(target, reply);
        assertEquals(List.of(PetOfficeTabNavigator.Result.ATTENTION_REQUESTED), results);
        submit(request); assertEquals(PetOfficeTabNavigator.Result.UNAVAILABLE, results.get(1));
        assertTrue(broker.poll(target).isEmpty());
    }

    @Test
    public void reconnectionCannotAcquireAnOldUndeliveredOrDeliveredRequest() throws Exception {
        submit(request()); var command = broker.poll(target).get(0);
        var replacement = registry.connect("pycharm", "next-connection");
        registry.commit(replacement, PetOfficeParticipantFixture.bytes(replacement, 1, 2, 2), 0);
        broker.complete(target, new PetOfficeRouteBroker.Reply(command.request().requestId(), command.ticket(), PetOfficeTabNavigator.Result.ACTIVATED));
        assertEquals(List.of(PetOfficeTabNavigator.Result.UNAVAILABLE), results);
        assertTrue(broker.poll(replacement).isEmpty());
    }

    @Test
    public void aClosedPageAndLostLeaseDiscardPendingCommands() {
        submit(request()); page.set(false);
        assertTrue(broker.poll(target).isEmpty()); assertTrue(results.isEmpty());
        page.set(true); submit(request()); owns.set(false);
        assertTrue(broker.poll(target).isEmpty());
        assertEquals(List.of(PetOfficeTabNavigator.Result.UNAVAILABLE), results);
    }

    @Test
    public void expiryIncludesQueueingTimeAndLateRepliesNeverBecomeSuccess() {
        var request = request(); submit(request);
        time.addAndGet(2_000_000_000L);
        var command = broker.poll(target).get(0); assertEquals(1000, command.remainingMillis());
        time.addAndGet(1_000_000_000L);
        broker.complete(target, new PetOfficeRouteBroker.Reply(request.requestId(), command.ticket(), PetOfficeTabNavigator.Result.ACTIVATED));
        assertEquals(List.of(PetOfficeTabNavigator.Result.UNAVAILABLE), results);
        broker.submit("page", request(), () -> true, results::add, 0);
        assertEquals(2, results.size()); assertTrue(broker.poll(target).isEmpty());
    }

    @Test
    public void staleBindingsAndForgedTicketsHaveNoNavigationAuthority() {
        var valid = request();
        submit(new PetOfficeTabNavigator.Request(valid.requestId(), "pycharm/tab-0/replacement", "route-0", ""));
        assertEquals(List.of(PetOfficeTabNavigator.Result.TARGET_GONE), results);
        var next = request(); submit(next); var command = broker.poll(target).get(0);
        broker.complete(target, new PetOfficeRouteBroker.Reply(next.requestId(), "wrong-ticket", PetOfficeTabNavigator.Result.ACTIVATED));
        assertEquals(1, results.size());
        broker.complete(target, new PetOfficeRouteBroker.Reply(next.requestId(), command.ticket(), PetOfficeTabNavigator.Result.STALE_INTERACTION));
        assertEquals(PetOfficeTabNavigator.Result.STALE_INTERACTION, results.get(1));
    }

    @Test
    public void admissionAndPollBatchesRemainBoundedAndPageCloseDoesNotResetDeduplication() {
        var first = request(); submit(first);
        for (int i = 0; i < 16; i++) { submit(request()); }
        assertEquals(List.of(PetOfficeTabNavigator.Result.UNAVAILABLE), results);
        assertEquals(4, broker.poll(target).size());
        broker.closePage("page");
        assertTrue(broker.poll(target).isEmpty());
        submit(first); assertEquals(2, results.size());
    }

    @Test
    public void routeCodecRejectsForeignOwnershipExtraActionsAndExpiredBudgets() throws Exception {
        submit(request());
        var encoded = PetOfficeRouteProtocol.encode(broker.poll(target));
        assertEquals(1, PetOfficeRouteProtocol.decode(encoded, "pycharm").size());
        assertThrows(IOException.class, () -> PetOfficeRouteProtocol.decode(encoded, "idea"));
        JsonObject command = encoded.get(0).getAsJsonObject();
        command.addProperty("answer", "yes");
        assertThrows(IOException.class, () -> PetOfficeRouteProtocol.decode(encoded, "pycharm"));
        command.remove("answer"); command.addProperty("remainingMillis", 0);
        assertThrows(IOException.class, () -> PetOfficeRouteProtocol.decode(encoded, "pycharm"));
    }
}
