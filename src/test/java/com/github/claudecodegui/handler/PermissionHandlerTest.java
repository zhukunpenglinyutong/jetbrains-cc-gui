package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link PermissionHandler}.
 *
 * <p>Controlled EDT dispatch and timers verify replay ordering and token isolation without real JCEF or timeout waits.</p>
 */
public class PermissionHandlerTest {

    private PermissionHandler handler;
    private RecordingJsCallback recordingJsCallback;

    @Before
    public void setUp() {
        recordingJsCallback = new RecordingJsCallback();
        handler = new PermissionHandler(contextStub());
    }

    @Test
    public void getSupportedTypesReturnsDialogIpcMessageTypes() {
        String[] actual = handler.getSupportedTypes().clone();
        String[] expected = {
                "permission_decision",
                "ask_user_question_response",
                "plan_approval_response",
                "dialog_delivery_ack"
        };
        Arrays.sort(actual);
        Arrays.sort(expected);
        assertArrayEquals(expected, actual);
    }

    @Test
    public void reportsPendingProviderInteractionForClawBotProgress() throws Exception {
        assertEquals("", handler.getClawBotPendingInteractionPhase());

        injectPlanApprovalFuture("plan-progress", new CompletableFuture<>());
        assertEquals("WAITING_PLAN_APPROVAL", handler.getClawBotPendingInteractionPhase());

        injectAskUserFuture("question-progress", new CompletableFuture<>());
        assertEquals("WAITING_USER", handler.getClawBotPendingInteractionPhase());
    }

    @Test
    public void exposesAskUserQuestionToClawBotAndResolvesTheSameFuture() throws Exception {
        HandlerContext context = contextStub();
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.getState().beginTurn();
        session.getState().addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "question"));
        context.setSession(session);
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                context, scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        JsonObject question = new JsonObject();
        question.addProperty("question", "选择颜色");
        JsonArray options = new JsonArray();
        options.add("红");
        options.add("蓝");
        question.add("options", options);
        JsonArray questions = new JsonArray();
        questions.add(question);
        JsonObject data = new JsonObject();
        data.add("questions", questions);

        CompletableFuture<JsonObject> future = configuredHandler.showAskUserQuestionDialog("remote-ask", data);
        List<com.github.claudecodegui.clawbot.ClawBotInteraction> interactions =
                configuredHandler.getClawBotInteractions();
        assertEquals(1, interactions.size());

        JsonObject answer = new JsonObject();
        JsonObject answers = new JsonObject();
        answers.addProperty("选择颜色", "蓝");
        answer.add("answers", answers);
        assertTrue(configuredHandler.answerClawBotInteraction(interactions.get(0).token(), answer));
        assertEquals("蓝", future.get(1, TimeUnit.SECONDS).get("选择颜色").getAsString());
        assertTrue(configuredHandler.getClawBotInteractions().isEmpty());
    }

    @Test
    public void handleReturnsFalseForUnknownType() {
        // The IPC bridge fans messages to every registered handler; returning false lets the
        // bridge try the next one. A false return value is therefore part of the contract, not
        // an error condition.
        assertFalse(handler.handle("totally_unknown_type", "{}"));
    }

    @Test
    public void handleDispatchesPermissionDecisionAndCompletesAllowFuture() throws Exception {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        injectPermissionFuture("ch-allow", future);

        String content = "{\"channelId\":\"ch-allow\",\"allow\":true,\"remember\":false}";
        assertTrue(handler.handle("permission_decision", content));

        Integer result = future.get(2, TimeUnit.SECONDS);
        assertEquals(PermissionService.PermissionResponse.ALLOW.getValue(), result.intValue());
        assertTrue("future should be removed from map after dispatch", getPermissionMap().isEmpty());
    }

    @Test
    public void handleDispatchesPermissionDecisionAndCompletesAllowAlwaysFuture() throws Exception {
        CompletableFuture<Integer> future = new CompletableFuture<>();
        injectPermissionFuture("ch-allow-always", future);

        String content = "{\"channelId\":\"ch-allow-always\",\"allow\":true,\"remember\":true}";
        assertTrue(handler.handle("permission_decision", content));

        Integer result = future.get(2, TimeUnit.SECONDS);
        assertEquals(PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue(), result.intValue());
    }

    @Test
    public void handleDispatchesAskUserQuestionResponse() throws Exception {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        injectAskUserFuture("auq-1", future);

        String content = "{\"requestId\":\"auq-1\",\"answers\":{\"color\":\"red\"}}";
        assertTrue(handler.handle("ask_user_question_response", content));

        JsonObject result = future.get(2, TimeUnit.SECONDS);
        assertEquals("red", result.get("color").getAsString());
        assertTrue(getAskUserMap().isEmpty());
    }

    @Test
    public void handleDispatchesPlanApprovalResponse() throws Exception {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        injectPlanApprovalFuture("plan-1", future);

        String content = "{\"requestId\":\"plan-1\",\"approved\":true,\"targetMode\":\"default\"}";
        assertTrue(handler.handle("plan_approval_response", content));

        JsonObject result = future.get(2, TimeUnit.SECONDS);
        assertTrue(result.get("approved").getAsBoolean());
        assertEquals("default", result.get("targetMode").getAsString());
        assertTrue(getPlanApprovalMap().isEmpty());
    }

    // The session-change safety net: when the user switches sessions while a permission dialog is
    // still on screen, every in-flight future must resolve immediately with a default-deny payload.
    // Otherwise the agent that issued the request hangs until the backend safety-net timer
    // fires — a delay long enough to look like a frozen session to the user.

    @Test
    public void clearPendingRequestsCompletesAllPermissionFuturesWithDeny() throws Exception {
        CompletableFuture<Integer> f1 = new CompletableFuture<>();
        CompletableFuture<Integer> f2 = new CompletableFuture<>();
        injectPermissionFuture("ch-1", f1);
        injectPermissionFuture("ch-2", f2);

        handler.clearPendingRequests();

        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                f1.get(1, TimeUnit.SECONDS).intValue());
        assertEquals(PermissionService.PermissionResponse.DENY.getValue(),
                f2.get(1, TimeUnit.SECONDS).intValue());
        assertTrue("permission map must be drained after clear", getPermissionMap().isEmpty());
    }

    @Test
    public void clearPendingRequestsCompletesAskUserQuestionFuturesWithNull() throws Exception {
        CompletableFuture<JsonObject> f1 = new CompletableFuture<>();
        CompletableFuture<JsonObject> f2 = new CompletableFuture<>();
        injectAskUserFuture("auq-1", f1);
        injectAskUserFuture("auq-2", f2);

        handler.clearPendingRequests();

        // AskUser path completes with null — the caller distinguishes "no answer" from an empty
        // answers object by reading null here. See PermissionService.handleAskUserQuestion.
        assertNull(f1.get(1, TimeUnit.SECONDS));
        assertNull(f2.get(1, TimeUnit.SECONDS));
        assertTrue("askUser map must be drained after clear", getAskUserMap().isEmpty());
    }

    @Test
    public void clearPendingRequestsCompletesPlanApprovalFuturesWithRejection() throws Exception {
        CompletableFuture<JsonObject> f1 = new CompletableFuture<>();
        injectPlanApprovalFuture("plan-1", f1);

        handler.clearPendingRequests();

        JsonObject result = f1.get(1, TimeUnit.SECONDS);
        assertNotNull(result);
        assertFalse("plan-approval default on session change must be reject", result.get("approved").getAsBoolean());
        assertEquals("Session changed", result.get("message").getAsString());
        assertTrue("planApproval map must be drained after clear", getPlanApprovalMap().isEmpty());
    }

    @Test
    public void clearPendingRequestsOnEmptyMapsIsHarmless() throws Exception {
        // Called on every session switch including the very first one; must not throw.
        handler.clearPendingRequests();
        assertTrue(getPermissionMap().isEmpty());
        assertTrue(getAskUserMap().isEmpty());
        assertTrue(getPlanApprovalMap().isEmpty());
    }

    // Documents the atomic-complete contract that backstops the three safety-net handlers. Each
    // handler does:   if (future.complete(deny)) { cleanup(); }
    // and relies on complete() to atomically reject the second caller. If complete() ever returned
    // true twice the cleanup would race the response handler's own remove() — losing or
    // duplicating IPC. JDK guarantees this; the test pins the assumption to the code we depend on.

    @Test
    public void completableFutureCompleteIsAtomic_winnerGetsTrue_loserGetsFalse()
            throws ExecutionException, InterruptedException, TimeoutException {
        CompletableFuture<Integer> future = new CompletableFuture<>();

        boolean firstWon = future.complete(1);
        boolean secondWon = future.complete(2);

        assertTrue("first complete() must win the race", firstWon);
        assertFalse("second complete() must be a no-op", secondWon);
        assertEquals("winner's value must survive the race", Integer.valueOf(1),
                future.get(1, TimeUnit.SECONDS));
    }

    @Test
    public void safetyNetTimeoutUsesConfiguredDialogTimeoutPlusBuffer() {
        FakeSettingsService settingsService = new FakeSettingsService(120);
        PermissionHandler configuredHandler = new PermissionHandler(contextStub(settingsService));

        assertEquals(180L, configuredHandler.getSafetyNetTimeoutSeconds());
    }

    @Test
    public void safetyNetTimeoutFallsBackToDefaultPlusBufferWhenSettingsServiceIsNull() {
        // When the handler context arrives without a settings service we use the same fallback
        // as the Node bridge: DEFAULT + buffer. Falling back to MAX would mean an hour-long
        // safety net for a transient failure.
        PermissionHandler nullSettingsHandler = new PermissionHandler(contextStub());

        long expected = CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
        assertEquals(expected, nullSettingsHandler.getSafetyNetTimeoutSeconds());
    }

    @Test
    public void safetyNetTimeoutFallsBackToDefaultPlusBufferWhenSettingsServiceThrows() {
        PermissionHandler throwingHandler = new PermissionHandler(contextStub(new FailingSettingsService()));

        long expected = CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
        assertEquals(expected, throwingHandler.getSafetyNetTimeoutSeconds());
    }

    @Test
    public void safetyNetScheduleIsCancelledWhenFutureCompletesBeforeTimeout() {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(contextStub(new FakeSettingsService(120)), scheduler);
        CompletableFuture<Integer> future = new CompletableFuture<>();

        configuredHandler.scheduleSafetyNet(future, () -> future.complete(42));

        assertEquals(180L, scheduler.lastDelaySeconds);
        assertFalse(scheduler.task.cancelled);

        future.complete(7);

        assertTrue(scheduler.task.cancelled);
        assertEquals(Integer.valueOf(7), future.join());
    }

    @Test
    public void safetyNetTaskStillCompletesFutureWhenItWinsRace() {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(contextStub(new FakeSettingsService(30)), scheduler);
        CompletableFuture<Integer> future = new CompletableFuture<>();

        configuredHandler.scheduleSafetyNet(future, () -> future.complete(42));
        scheduler.runnable.run();

        assertEquals(Integer.valueOf(42), future.join());
        assertTrue(scheduler.task.cancelled);
    }

    @Test
    public void showAskUserQuestionDialogTriggersReminderNotification() {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        FakeAskUserQuestionVisualNotifier visualNotifier = new FakeAskUserQuestionVisualNotifier();
        FakeAskUserQuestionSoundNotifier soundNotifier = new FakeAskUserQuestionSoundNotifier();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                visualNotifier, soundNotifier);

        JsonObject questions = new JsonObject();
        configuredHandler.showAskUserQuestionDialog("ask-1", questions);

        assertEquals(1, visualNotifier.callCount);
        assertEquals(1, soundNotifier.callCount);
    }

    // Replay coverage: a page (re)load can silently drop the one-shot dialog-show
    // injection, which used to leave the future blocked until the safety net fired
    // with the dialog never shown. frontend_ready now replays every pending show,
    // and close signals are parked until they can be replayed too.

    @Test
    public void replayPendingDialogsReinjectsPendingAskUserQuestionShow() {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        JsonObject questions = new JsonObject();
        questions.addProperty("requestId", "ask-replay");
        configuredHandler.showAskUserQuestionDialog("ask-replay", questions);
        int injectionsAfterShow = recordingJsCallback.executedScripts.size();

        configuredHandler.replayPendingDialogsToWebview();

        assertTrue("replay must re-inject the pending show",
                recordingJsCallback.executedScripts.size() > injectionsAfterShow);
        String reinjected = recordingJsCallback.executedScripts.get(
                recordingJsCallback.executedScripts.size() - 1);
        assertTrue("replayed script must call the webview show function",
                reinjected.contains("showAskUserQuestionDialog"));
        assertTrue("replayed script must carry the original payload",
                reinjected.contains("ask-replay"));
    }

    @Test
    public void replayPendingDialogsIsHarmlessWhenNothingIsPending() {
        int injectionsBefore = recordingJsCallback.executedScripts.size();

        handler.replayPendingDialogsToWebview();

        assertEquals(injectionsBefore, recordingJsCallback.executedScripts.size());
    }

    @Test
    public void replayPendingDialogsSkipsResolvedRequests() throws Exception {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        configuredHandler.showAskUserQuestionDialog("ask-answered", new JsonObject());
        // The user answered before frontend_ready arrived: the future is completed
        // and the entry removed, so replay must not resurrect the dialog.
        configuredHandler.handle("ask_user_question_response",
                "{\"requestId\":\"ask-answered\",\"dialogToken\":\""
                        + getAskUserMapOf(configuredHandler).get("ask-answered").dialogToken + "\",\"answers\":{}}");
        int injectionsBeforeReplay = countScriptsContaining("showAskUserQuestionDialog");

        configuredHandler.replayPendingDialogsToWebview();

        assertEquals(injectionsBeforeReplay, countScriptsContaining("showAskUserQuestionDialog"));
        assertTrue(getAskUserMapOf(configuredHandler).isEmpty());
    }

    @Test
    public void safetyNetTimeoutRecordsUndeliveredCloseSignalForReplay() throws Exception {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        configuredHandler.showAskUserQuestionDialog("ask-timeout", new JsonObject());
        scheduler.runnable.run(); // fire the safety net → forceClose issued

        Deque<PermissionHandler.UndeliveredCloseSignal> signals =
                getUndeliveredCloseSignals(configuredHandler);
        assertEquals("close signal must be parked for replay", 1, signals.size());
        assertEquals("forceCloseAskUserQuestionDialog", signals.getFirst().functionName);
    }

    @Test
    public void delayedAcknowledgementOnlyRemovesItsOwnToken() throws Exception {
        Method record = PermissionHandler.class.getDeclaredMethod(
                "recordUndeliveredCloseSignal", String.class, String.class, String.class);
        record.setAccessible(true);
        record.invoke(handler, "forceClosePermissionDialog", "channel-1", "token-old");
        record.invoke(handler, "forceClosePermissionDialog", "channel-1", "token-new");

        Deque<PermissionHandler.UndeliveredCloseSignal> signals =
                getUndeliveredCloseSignals(handler);
        assertEquals(2, signals.size());
        handler.handle("dialog_delivery_ack",
                "{\"functionName\":\"forceClosePermissionDialog\",\"targetId\":\"channel-1\",\"dialogToken\":\"token-old\"}");
        assertEquals(1, signals.size());
        assertEquals("token-new", signals.getFirst().dialogToken);
    }

    @Test
    public void deliveryAckWithoutTargetIdDoesNotClearParkedCloseSignal() throws Exception {
        Method record = PermissionHandler.class.getDeclaredMethod(
                "recordUndeliveredCloseSignal", String.class, String.class, String.class);
        record.setAccessible(true);
        record.invoke(handler, "forceClosePermissionDialog", "channel-1", "token");

        // A malformed ack without targetId must not fall back to "" and match a
        // close-all signal; the parked signal stays parked.
        handler.handle("dialog_delivery_ack", "{\"functionName\":\"forceClosePermissionDialog\"}");

        assertEquals(1, getUndeliveredCloseSignals(handler).size());
    }

    @Test
    public void dialogDeliveryAcknowledgementRemovesCloseSignal() throws Exception {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        configuredHandler.showAskUserQuestionDialog("ask-ack", new JsonObject());
        scheduler.runnable.run();
        assertEquals(1, getUndeliveredCloseSignals(configuredHandler).size());

        configuredHandler.handle("dialog_delivery_ack",
                "{\"functionName\":\"forceCloseAskUserQuestionDialog\",\"targetId\":\"ask-ack\",\"dialogToken\":\""
                        + getUndeliveredCloseSignals(configuredHandler).getFirst().dialogToken + "\"}");

        assertTrue(getUndeliveredCloseSignals(configuredHandler).isEmpty());
    }

    @Test
    public void nextShowFlushesUndeliveredCloseSignalsBeforeInjectingTheShow() throws Exception {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        configuredHandler.showAskUserQuestionDialog("ask-orphan", new JsonObject());
        scheduler.runnable.run(); // park a close signal for "ask-orphan"

        configuredHandler.showAskUserQuestionDialog("ask-next", new JsonObject());

        Deque<PermissionHandler.UndeliveredCloseSignal> signals =
                getUndeliveredCloseSignals(configuredHandler);
        assertFalse("flushed signals remain until the frontend acknowledges delivery",
                signals.isEmpty());
        // The close for the orphaned request must have been re-injected; the show
        // for "ask-next" follows it in FIFO order.
        String closeScript = findScriptContaining("forceCloseAskUserQuestionDialog");
        assertNotNull(closeScript);
        assertTrue(closeScript.contains("ask-orphan"));
        int closeIndex = recordingJsCallback.executedScripts.indexOf(closeScript);
        int nextShowIndex = findLastIndexContaining("showAskUserQuestionDialog");
        assertTrue("close replay must precede the new show injection", closeIndex < nextShowIndex);
    }

    @Test
    public void answeredPermissionDialogIgnoresDuplicateResponses() throws Exception {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        configuredHandler.showFrontendPermissionDialog("Bash", new JsonObject());
        String channelId = getPermissionMapOf(configuredHandler).keySet().iterator().next();
        PermissionHandler.PendingDialogShow<Integer> pending =
                getPermissionMapOf(configuredHandler).get(channelId);

        configuredHandler.handle("permission_decision",
                "{\"channelId\":\"" + channelId + "\",\"dialogToken\":\"" + pending.dialogToken
                        + "\",\"allow\":true,\"remember\":false}");

        assertTrue("the answered dialog's future must be resolved", pending.future.isDone());
        configuredHandler.handle("permission_decision",
                "{\"channelId\":\"" + channelId + "\",\"allow\":false,\"remember\":false}");
        assertEquals(Integer.valueOf(PermissionService.PermissionResponse.ALLOW.getValue()), pending.future.join());
    }

    @Test
    public void safetyNetTimeoutIgnoresLateDecisions() throws Exception {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(
                contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());

        configuredHandler.showFrontendPermissionDialog("Bash", new JsonObject());
        String channelId = getPermissionMapOf(configuredHandler).keySet().iterator().next();
        PermissionHandler.PendingDialogShow<Integer> pending =
                getPermissionMapOf(configuredHandler).get(channelId);

        scheduler.runnable.run(); // safety-net fires: future resolved with DENY, dialog force-closed

        assertTrue("the timed-out dialog's future must be resolved", pending.future.isDone());
        configuredHandler.handle("permission_decision",
                "{\"channelId\":\"" + channelId + "\",\"dialogToken\":\"" + pending.dialogToken
                        + "\",\"allow\":true,\"remember\":false}");
        assertEquals(Integer.valueOf(PermissionService.PermissionResponse.DENY.getValue()), pending.future.join());
    }

    @Test
    public void staleAndUnversionedResponsesCannotConsumeCurrentDialogs() throws Exception {
        CompletableFuture<Integer> permission = new CompletableFuture<>();
        CompletableFuture<JsonObject> ask = new CompletableFuture<>();
        CompletableFuture<JsonObject> plan = new CompletableFuture<>();
        getPermissionMap().put("reused", new PermissionHandler.PendingDialogShow<>(permission, "{}", 1, "current"));
        getAskUserMap().put("reused", new PermissionHandler.PendingDialogShow<>(ask, "{}", 2, "current"));
        getPlanApprovalMap().put("reused", new PermissionHandler.PendingDialogShow<>(plan, "{}", 3, "current"));
        for (String token : new String[]{"", ",\"dialogToken\":\"old\""}) {
            handler.handle("permission_decision", "{\"channelId\":\"reused\",\"allow\":true,\"remember\":false" + token + "}");
            handler.handle("ask_user_question_response", "{\"requestId\":\"reused\",\"answers\":{}" + token + "}");
            handler.handle("plan_approval_response", "{\"requestId\":\"reused\",\"approved\":true" + token + "}");
        }
        assertFalse(permission.isDone());
        assertFalse(ask.isDone());
        assertFalse(plan.isDone());
        assertTrue(getUndeliveredCloseSignals(handler).isEmpty());
    }

    @Test
    public void legacyTimeoutCannotResolveReplacementInPermissionManager() {
        com.github.claudecodegui.permission.PermissionManager manager = new com.github.claudecodegui.permission.PermissionManager();
        com.github.claudecodegui.permission.PermissionRequest old = manager.createRequest("reused", "Bash", Map.of(), null, null);
        com.github.claudecodegui.permission.PermissionRequest current = manager.createRequest("reused", "Bash", Map.of(), null, null);

        manager.handlePermissionDecision(old, false, false, "Timed out");

        assertTrue(old.getResultFuture().isDone());
        assertFalse(current.getResultFuture().isDone());
        manager.handlePermissionDecision(current, true, true, "");
        assertEquals(com.github.claudecodegui.permission.PermissionRequest.PermissionResult.Behavior.ALLOW,
                current.getResultFuture().join().getBehavior());
        assertTrue(manager.createRequest("next", "Bash", Map.of(), null, null).getResultFuture().isDone());
    }

    @Test
    public void remotePermissionDecisionCannotBeOverwrittenByLateIdeDecision() {
        com.github.claudecodegui.permission.PermissionManager manager = new com.github.claudecodegui.permission.PermissionManager();
        com.github.claudecodegui.permission.PermissionRequest request =
                manager.createRequest("remote-approval", "Bash", Map.of(), null, null);

        assertTrue(manager.tryHandleRemotePermissionDecision(request, true, null));
        manager.handlePermissionDecision(request, false, false, "Late IDE denial");

        assertEquals(com.github.claudecodegui.permission.PermissionRequest.PermissionResult.Behavior.ALLOW,
                request.getResultFuture().join().getBehavior());
    }

    @Test
    public void concurrentRemoteAndIdePermissionDecisionsResolveExactlyOnce() throws Exception {
        com.github.claudecodegui.permission.PermissionManager manager = new com.github.claudecodegui.permission.PermissionManager();
        com.github.claudecodegui.permission.PermissionRequest request =
                manager.createRequest("remote-race", "Bash", Map.of(), null, null);
        java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
        java.util.concurrent.ExecutorService executor = java.util.concurrent.Executors.newFixedThreadPool(2);
        try {
            java.util.concurrent.Future<?> ideDecision = executor.submit(() -> {
                awaitLatch(start);
                manager.handlePermissionDecision(request, false, false, "IDE denial");
            });
            java.util.concurrent.Future<Boolean> remoteDecision = executor.submit(() -> {
                awaitLatch(start);
                return manager.tryHandleRemotePermissionDecision(request, true, null);
            });
            start.countDown();
            ideDecision.get(2, TimeUnit.SECONDS);
            remoteDecision.get(2, TimeUnit.SECONDS);

            assertTrue(request.getResultFuture().isDone());
            assertTrue(request.isResolved());
        } finally {
            executor.shutdownNow();
        }
    }

    private void awaitLatch(java.util.concurrent.CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while waiting to start decision race", exception);
        }
    }

    @Test
    public void legacyRequestUsesBoundHandlerAndRejectsStaleToken() throws Exception {
        FakeSafetyNetScheduler scheduler = new FakeSafetyNetScheduler();
        PermissionHandler configuredHandler = new PermissionHandler(contextStub(), scheduler, new FakeEdtDispatcher(),
                new FakeAskUserQuestionVisualNotifier(), new FakeAskUserQuestionSoundNotifier());
        com.github.claudecodegui.permission.PermissionRequest request =
                new com.github.claudecodegui.permission.PermissionRequest("legacy", "Bash", Map.of(), null, null);
        configuredHandler.showPermissionDialog(request);
        assertNotNull(findScriptContaining("showPermissionDialog"));
        configuredHandler.handle("permission_decision",
                "{\"channelId\":\"legacy\",\"allow\":true,\"remember\":false,\"dialogToken\":\"stale\"}");
        assertFalse(request.getResultFuture().isDone());
        request.reject("Canceled", true);
        assertEquals(1, getUndeliveredCloseSignals(configuredHandler).size());
    }

    @Test
    public void orphanResponsesDoNotSendUnversionedClose() throws Exception {
        handler.handle("ask_user_question_response", "{\"requestId\":\"missing\",\"answers\":{}}");
        handler.handle("plan_approval_response", "{\"requestId\":\"missing\",\"approved\":true}");
        assertTrue(getUndeliveredCloseSignals(handler).isEmpty());
    }

    @SuppressWarnings("unchecked")
    private Map<String, PermissionHandler.PendingDialogShow<Integer>> getPermissionMapOf(
            PermissionHandler target) throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingPermissionRequests");
        f.setAccessible(true);
        return (Map<String, PermissionHandler.PendingDialogShow<Integer>>) f.get(target);
    }

    @SuppressWarnings("unchecked")
    private Map<String, PermissionHandler.PendingDialogShow<JsonObject>> getAskUserMapOf(
            PermissionHandler target) throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingAskUserQuestionRequests");
        f.setAccessible(true);
        return (Map<String, PermissionHandler.PendingDialogShow<JsonObject>>) f.get(target);
    }

    private String findScriptContaining(String needle) {
        for (String script : recordingJsCallback.executedScripts) {
            if (script.contains(needle)) {
                return script;
            }
        }
        return null;
    }

    private int findLastIndexContaining(String needle) {
        for (int i = recordingJsCallback.executedScripts.size() - 1; i >= 0; i--) {
            if (recordingJsCallback.executedScripts.get(i).contains(needle)) {
                return i;
            }
        }
        return -1;
    }

    private int countScriptsContaining(String needle) {
        int count = 0;
        for (String script : recordingJsCallback.executedScripts) {
            if (script.contains(needle)) {
                count++;
            }
        }
        return count;
    }

    // --- reflection helpers (the three pending-request maps are private) ---

    @SuppressWarnings("unchecked")
    private Map<String, PermissionHandler.PendingDialogShow<Integer>> getPermissionMap()
            throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingPermissionRequests");
        f.setAccessible(true);
        return (Map<String, PermissionHandler.PendingDialogShow<Integer>>) f.get(handler);
    }

    @SuppressWarnings("unchecked")
    private Map<String, PermissionHandler.PendingDialogShow<JsonObject>> getAskUserMap()
            throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingAskUserQuestionRequests");
        f.setAccessible(true);
        return (Map<String, PermissionHandler.PendingDialogShow<JsonObject>>) f.get(handler);
    }

    @SuppressWarnings("unchecked")
    private Map<String, PermissionHandler.PendingDialogShow<JsonObject>> getPlanApprovalMap()
            throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingPlanApprovalRequests");
        f.setAccessible(true);
        return (Map<String, PermissionHandler.PendingDialogShow<JsonObject>>) f.get(handler);
    }

    @SuppressWarnings("unchecked")
    private Deque<PermissionHandler.UndeliveredCloseSignal> getUndeliveredCloseSignals(
            PermissionHandler target) throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("undeliveredCloseSignals");
        f.setAccessible(true);
        return (Deque<PermissionHandler.UndeliveredCloseSignal>) f.get(target);
    }

    private void injectPermissionFuture(String key, CompletableFuture<Integer> future)
            throws NoSuchFieldException, IllegalAccessException {
        getPermissionMap().put(key, new PermissionHandler.PendingDialogShow<>(future, "{}", 0L, null));
    }

    private void injectAskUserFuture(String key, CompletableFuture<JsonObject> future)
            throws NoSuchFieldException, IllegalAccessException {
        getAskUserMap().put(key, new PermissionHandler.PendingDialogShow<>(future, "{}", 0L, null));
    }

    private void injectPlanApprovalFuture(String key, CompletableFuture<JsonObject> future)
            throws NoSuchFieldException, IllegalAccessException {
        getPlanApprovalMap().put(key, new PermissionHandler.PendingDialogShow<>(future, "{}", 0L, null));
    }

    private HandlerContext contextStub() {
        return contextStub(null);
    }

    private HandlerContext contextStub(CodemossSettingsService settingsService) {
        return new HandlerContext(
                null,
                null,
                null,
                settingsService,
                recordingJsCallback
        );
    }

    private static class FakeSettingsService extends CodemossSettingsService {
        private final int timeoutSeconds;

        private FakeSettingsService(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }

        @Override
        public int getPermissionDialogTimeoutSeconds() throws IOException {
            return timeoutSeconds;
        }
    }

    private static class FailingSettingsService extends CodemossSettingsService {
        @Override
        public int getPermissionDialogTimeoutSeconds() throws IOException {
            throw new IOException("simulated settings read failure");
        }
    }

    private static class FakeSafetyNetScheduler implements PermissionHandler.SafetyNetScheduler {
        private Runnable runnable;
        private long lastDelaySeconds;
        private FakeCancellableTask task;

        @Override
        public PermissionHandler.CancellableTask schedule(Runnable task, long delaySeconds) {
            this.runnable = task;
            this.lastDelaySeconds = delaySeconds;
            this.task = new FakeCancellableTask();
            return this.task;
        }
    }

    private static class FakeCancellableTask implements PermissionHandler.CancellableTask {
        private boolean cancelled;

        @Override
        public void cancel() {
            cancelled = true;
        }
    }

    private static class FakeAskUserQuestionVisualNotifier implements PermissionHandler.AskUserQuestionVisualNotifier {
        private int callCount;

        @Override
        public void remind() {
            callCount++;
        }
    }

    private static class FakeAskUserQuestionSoundNotifier implements PermissionHandler.AskUserQuestionSoundNotifier {
        private int callCount;

        @Override
        public void play() {
            callCount++;
        }
    }

    /** Runs injections inline and is paired with {@link RecordingJsCallback} to observe scripts. */
    private static class FakeEdtDispatcher implements PermissionHandler.EdtDispatcher {
        @Override
        public void post(Runnable runnable) {
            runnable.run();
        }
    }

    private static class RecordingJsCallback implements HandlerContext.JsCallback {
        private final java.util.List<String> executedScripts = new java.util.ArrayList<>();

        @Override
        public void callJavaScript(String functionName, String... args) {
        }

        @Override
        public String escapeJs(String str) {
            return str;
        }

        @Override
        public void executeJavaScript(String jsCode) {
            executedScripts.add(jsCode);
        }
    }
}
