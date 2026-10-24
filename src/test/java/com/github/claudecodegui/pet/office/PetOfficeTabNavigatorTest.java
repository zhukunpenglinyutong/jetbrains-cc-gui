package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.session.SessionExecutionState;
import com.github.claudecodegui.session.SessionState;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.Assert.*;

public class PetOfficeTabNavigatorTest {
    private final AtomicLong time = new AtomicLong();
    private final AtomicInteger activations = new AtomicInteger();
    private final List<Runnable> queued = new ArrayList<>();
    private final List<PetOfficeTabNavigator.Result> replies = new ArrayList<>();
    private PetOfficeSessionRegistry registry;
    private PetOfficeTabNavigator navigator;
    private SessionState state;
    private PetOfficeSessionRegistry.Registration registration;
    private PetOfficeTabNavigator.Target target;

    @Before public void setUp() {
        registry = new PetOfficeSessionRegistry("instance");
        navigator = new PetOfficeTabNavigator(registry, queued::add, time::get);
        state = new SessionState();
        registration = registry.register(new PetOfficeSessionRegistry.Metadata("tab", "IC", "IDEA", "project", "Project", "AI1"), state);
        target = (request, valid) -> { assertTrue(valid.getAsBoolean()); activations.incrementAndGet(); return PetOfficeTabNavigator.Result.ATTENTION_REQUESTED; };
        navigator.register("tab", target);
    }
    private PetOfficeTabNavigator.Request request(String interaction) {
        var source = registry.snapshot().sources().get(0);
        return new PetOfficeTabNavigator.Request(UUID.randomUUID().toString(), PetOfficeSessionRegistry.key(source.sourceKey()), source.routeGeneration(), interaction);
    }
    private void send(PetOfficeTabNavigator.Request request) { navigator.navigate("page", request, () -> true, replies::add); }

    @Test public void onlyTheRegisteredLocalTargetReceivesNavigationAndFocusDenialIsExplicit() {
        send(request("")); assertEquals(0, activations.get()); queued.remove(0).run();
        assertEquals(1, activations.get()); assertEquals(List.of(PetOfficeTabNavigator.Result.ATTENTION_REQUESTED), replies);
    }
    @Test public void closedTargetIsNotRecreatedByQueuedNavigation() {
        send(request("")); registration.close(); navigator.unregister("tab"); queued.remove(0).run();
        assertEquals(0, activations.get()); assertEquals(List.of(PetOfficeTabNavigator.Result.TARGET_GONE), replies);
    }
    @Test public void reboundTabCannotAcquireTheOldRoute() {
        send(request("")); state.setProvider("codex"); queued.remove(0).run();
        assertEquals(0, activations.get()); assertEquals(List.of(PetOfficeTabNavigator.Result.TARGET_GONE), replies);
    }
    @Test public void locallyAnsweredQuestionIsRecheckedAgainstActualTracker() {
        state.beginTurn();
        var execution = state.getExecutionState();
        var interaction = execution.beginInteraction(execution.currentTurn(), SessionExecutionState.WaitReason.QUESTION);
        registry.observe(); send(request(interaction.id())); execution.endInteraction(interaction); queued.remove(0).run();
        assertEquals(0, activations.get()); assertEquals(List.of(PetOfficeTabNavigator.Result.STALE_INTERACTION), replies);
    }
    @Test public void timeoutAndPageRetirementPreventLateEdtActivation() {
        send(request("")); time.set(3_000_000_000L); queued.remove(0).run();
        assertEquals(List.of(PetOfficeTabNavigator.Result.UNAVAILABLE), replies);
        send(request("")); navigator.closePage("page"); queued.remove(0).run();
        assertEquals(0, activations.get()); assertEquals(1, replies.size());
    }
    @Test public void pageGuardIsRecheckedInsideTheTarget() {
        AtomicBoolean valid = new AtomicBoolean(true);
        target = (request, guard) -> { valid.set(false); assertFalse(guard.getAsBoolean()); return PetOfficeTabNavigator.Result.UNAVAILABLE; };
        navigator.register("tab", target);
        navigator.navigate("page", request(""), valid::get, replies::add); queued.remove(0).run();
        assertEquals(0, replies.size());
    }
    @Test public void blockedEdtHasBoundedPendingRequests() {
        for (int i = 0; i < 17; i++) { send(request("")); }
        assertEquals(16, queued.size()); assertEquals(List.of(PetOfficeTabNavigator.Result.UNAVAILABLE), replies);
        navigator.closePage("page"); queued.forEach(Runnable::run); assertEquals(0, activations.get());
    }
    @Test public void duplicateCompletedRequestNeverReactivatesTheTarget() {
        var request = request(""); send(request); queued.remove(0).run(); send(request);
        assertEquals(1, activations.get()); assertEquals(0, queued.size());
        assertEquals(PetOfficeTabNavigator.Result.UNAVAILABLE, replies.get(1));
    }
    @Test public void tabBindingGuardRejectsReplacementBeforeRegistryObservation() {
        var request = request(""); state.setProvider("codex");
        assertEquals(PetOfficeTabNavigator.Result.TARGET_GONE, PetOfficeTabNavigator.validateBinding(request, state.getExecutionSnapshot()));
    }
    @Test public void admissionAfterAnEdtStallDoesNotResetTheOriginalDeadline() {
        var request = request(""); time.set(4_000_000_000L);
        navigator.navigate("page", request, () -> true, replies::add, 0);
        queued.remove(0).run();
        assertEquals(0, activations.get()); assertEquals(List.of(PetOfficeTabNavigator.Result.UNAVAILABLE), replies);
    }
}
