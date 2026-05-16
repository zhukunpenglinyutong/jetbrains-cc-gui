package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.lang.reflect.Field;
import java.util.Arrays;
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
 * <p>The dialog-show entry points ({@code showFrontendPermissionDialog},
 * {@code showAskUserQuestionDialog}, {@code showPlanApprovalDialog}) post to the IntelliJ EDT via
 * {@code ApplicationManager.getApplication().invokeLater(...)}, so they require the full plugin
 * test fixture and a backend safety-net wait to exercise the real safety net — not feasible in a plain JUnit
 * unit test. Instead we cover the testable surface:</p>
 *
 * <ul>
 *   <li>{@link PermissionHandler#getSupportedTypes()} — the IPC dispatch table.</li>
 *   <li>{@link PermissionHandler#handle(String, String)} — the dispatch path for each supported
 *       type, plus rejection of unknown types.</li>
 *   <li>{@link PermissionHandler#clearPendingRequests()} — the session-change safety net that
 *       fans default-deny payloads to every in-flight future.</li>
 *   <li>The atomic {@link CompletableFuture#complete(Object)} contract that the three safety-net
 *       timers depend on (see PermissionHandler L2).</li>
 * </ul>
 *
 * <p>Pending-request maps are populated via reflection so we can exercise the response paths
 * without going through the EDT.</p>
 */
public class PermissionHandlerTest {

    private PermissionHandler handler;

    @Before
    public void setUp() {
        handler = new PermissionHandler(contextStub());
    }

    @Test
    public void getSupportedTypesReturnsTheThreeIpcMessageTypes() {
        // Order is part of the dispatch contract documented in PermissionHandler.SUPPORTED_TYPES,
        // but the asserted property here is set-membership: the bridge will deliver any of these
        // three keys and the handler must claim ownership of all three.
        String[] actual = handler.getSupportedTypes().clone();
        String[] expected = {
                "permission_decision",
                "ask_user_question_response",
                "plan_approval_response"
        };
        Arrays.sort(actual);
        Arrays.sort(expected);
        assertArrayEquals(expected, actual);
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

    // --- reflection helpers (the three pending-request maps are private) ---

    @SuppressWarnings("unchecked")
    private Map<String, CompletableFuture<Integer>> getPermissionMap()
            throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingPermissionRequests");
        f.setAccessible(true);
        return (Map<String, CompletableFuture<Integer>>) f.get(handler);
    }

    @SuppressWarnings("unchecked")
    private Map<String, CompletableFuture<JsonObject>> getAskUserMap()
            throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingAskUserQuestionRequests");
        f.setAccessible(true);
        return (Map<String, CompletableFuture<JsonObject>>) f.get(handler);
    }

    @SuppressWarnings("unchecked")
    private Map<String, CompletableFuture<JsonObject>> getPlanApprovalMap()
            throws NoSuchFieldException, IllegalAccessException {
        Field f = PermissionHandler.class.getDeclaredField("pendingPlanApprovalRequests");
        f.setAccessible(true);
        return (Map<String, CompletableFuture<JsonObject>>) f.get(handler);
    }

    private void injectPermissionFuture(String key, CompletableFuture<Integer> future)
            throws NoSuchFieldException, IllegalAccessException {
        getPermissionMap().put(key, future);
    }

    private void injectAskUserFuture(String key, CompletableFuture<JsonObject> future)
            throws NoSuchFieldException, IllegalAccessException {
        getAskUserMap().put(key, future);
    }

    private void injectPlanApprovalFuture(String key, CompletableFuture<JsonObject> future)
            throws NoSuchFieldException, IllegalAccessException {
        getPlanApprovalMap().put(key, future);
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
                new HandlerContext.JsCallback() {
                    @Override public void callJavaScript(String functionName, String... args) {}
                    @Override public String escapeJs(String str) { return str; }
                }
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
}
