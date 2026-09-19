package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionManager;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.SoundNotificationService;
import com.github.claudecodegui.util.SystemNotificationService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Permission handler.
 * Handles permission dialog display and decision processing.
 */
public class PermissionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PermissionHandler.class);

    /** Gson is stateless and thread-safe, so a single shared instance suffices. */
    private static final Gson GSON = new Gson();

    private static final String DIALOG_DELIVERY_ACK_TYPE = "dialog_delivery_ack";

    private static final String[] SUPPORTED_TYPES = {
        "permission_decision",
        "ask_user_question_response",
        "plan_approval_response",
        DIALOG_DELIVERY_ACK_TYPE
    };

    private static int payloadLength(String value) {
        return value == null ? 0 : value.length();
    }

    private static String errorClass(Exception error) {
        return error.getClass().getSimpleName();
    }

    interface CancellableTask {
        void cancel();
    }

    interface SafetyNetScheduler {
        CancellableTask schedule(Runnable task, long delaySeconds);
    }

    interface AskUserQuestionVisualNotifier {
        void remind();
    }

    interface AskUserQuestionSoundNotifier {
        void play();
    }

    /**
     * Posts a JS-injection runnable onto the EDT. Abstracted so tests can capture
     * injections without a running IntelliJ application.
     */
    interface EdtDispatcher {
        void post(Runnable runnable);
    }

    private static final EdtDispatcher DEFAULT_EDT_DISPATCHER = runnable ->
            ApplicationManager.getApplication().invokeLater(runnable);

    private static final SafetyNetScheduler DEFAULT_SAFETY_NET_SCHEDULER = (task, delaySeconds) -> {
        ScheduledFuture<?> scheduledFuture = AppExecutorUtil.getAppScheduledExecutorService()
                .schedule(task, delaySeconds, TimeUnit.SECONDS);
        return () -> scheduledFuture.cancel(false);
    };

    private final SafetyNetScheduler safetyNetScheduler;
    private final AskUserQuestionVisualNotifier askUserQuestionVisualNotifier;
    private final AskUserQuestionSoundNotifier askUserQuestionSoundNotifier;
    private final EdtDispatcher edtDispatcher;

    /**
     * A dialog request still waiting for the user's answer, retaining the escaped
     * JS payload so the show call can be replayed after the webview (re)loads.
     */
    static final class PendingDialogShow<T> {
        final CompletableFuture<T> future;
        final String escapedJson;
        final long sequence;
        final String dialogToken;

        PendingDialogShow(
                CompletableFuture<T> future,
                String escapedJson,
                long sequence,
                String dialogToken
        ) {
            this.future = future;
            this.escapedJson = escapedJson;
            this.sequence = sequence;
            this.dialogToken = dialogToken;
        }
    }

    static final class PendingLegacyPermission {
        final PermissionRequest request;
        final PermissionManager owner;
        final String escapedJson;
        final long sequence;
        final String dialogToken;

        PendingLegacyPermission(
                PermissionRequest request,
                PermissionManager owner,
                String escapedJson,
                long sequence,
                String dialogToken
        ) {
            this.request = request;
            this.owner = owner;
            this.escapedJson = escapedJson;
            this.sequence = sequence;
            this.dialogToken = dialogToken;
        }
    }

    /**
     * One pending dialog, captured under {@code dialogLock} so the show can be
     * re-injected after a webview (re)load. Carries the owning map so the
     * re-injection can re-check, at dispatch time, that this exact entry is still
     * the pending one — a resolved or superseded request must not be resurrected.
     */
    private static final class DialogReplay {
        final String functionName;
        final String requestKey;
        final Map<String, ?> pendingMap;
        final PendingDialogShow<?> pending;
        final PendingLegacyPermission legacy;

        DialogReplay(
                String functionName,
                String requestKey,
                Map<String, ?> pendingMap,
                PendingDialogShow<?> pending,
                PendingLegacyPermission legacy
        ) {
            this.functionName = functionName;
            this.requestKey = requestKey;
            this.pendingMap = pendingMap;
            this.pending = pending;
            this.legacy = legacy;
        }

        long sequence() {
            return pending != null ? pending.sequence : legacy.sequence;
        }

        String escapedJson() {
            return pending != null ? pending.escapedJson : legacy.escapedJson;
        }

        boolean isStillPending() {
            if (pendingMap.get(requestKey) != (pending != null ? pending : legacy)) {
                return false;
            }
            return pending != null
                    ? !pending.future.isDone()
                    : !legacy.request.getResultFuture().isDone();
        }
    }

    // Permission request map
    private final Map<String, PendingDialogShow<Integer>> pendingPermissionRequests = new ConcurrentHashMap<>();

    // Legacy PermissionRequest instances use the session's PermissionManager rather than the
    // CompletableFuture dialog API, but still need the same page-ready replay behavior.
    private final Map<String, PendingLegacyPermission> pendingLegacyPermissionRequests =
            new ConcurrentHashMap<>();

    // AskUserQuestion request map
    private final Map<String, PendingDialogShow<JsonObject>> pendingAskUserQuestionRequests = new ConcurrentHashMap<>();

    // PlanApproval request map
    private final Map<String, PendingDialogShow<JsonObject>> pendingPlanApprovalRequests = new ConcurrentHashMap<>();

    private final Object dialogLock = new Object();
    private final AtomicLong nextDialogSequence = new AtomicLong();

    /**
     * Close signals whose one-shot injection may have been silently dropped
     * (browser swap cleared the queue, browser absent, script lost mid-navigation).
     * An undelivered close leaves an orphan dialog whose open-refs block every
     * later show call (issue #1360), so signals are replayed before the next show
     * and on frontend_ready. Replay is idempotent: forceClose only closes the
     * dialog matching the id and prunes queue entries.
     */
    private static final int MAX_UNDELIVERED_CLOSE_SIGNALS = 64;

    private final Deque<UndeliveredCloseSignal> undeliveredCloseSignals = new ArrayDeque<>();

    static final class UndeliveredCloseSignal {
        final String functionName;
        final String targetId;
        // Sessions may reuse IDs, so closes and acknowledgements must identify requests independently of the clock.
        final String dialogToken;

        UndeliveredCloseSignal(String functionName, String targetId, String dialogToken) {
            this.functionName = functionName;
            this.targetId = targetId;
            this.dialogToken = dialogToken;
        }
    }

    // Permission denied callback
    public interface PermissionDeniedCallback {
        void onPermissionDenied();
    }

    private PermissionDeniedCallback deniedCallback;

    public PermissionHandler(HandlerContext context) {
        this(context, DEFAULT_SAFETY_NET_SCHEDULER);
    }

    PermissionHandler(HandlerContext context, SafetyNetScheduler safetyNetScheduler) {
        this(context, safetyNetScheduler,
                () -> SystemNotificationService.getInstance()
                        .showAskUserQuestionReminderToast(context.getProject()),
                () -> SoundNotificationService.getInstance()
                        .playAskUserQuestionReminderSound());
    }

    PermissionHandler(HandlerContext context, SafetyNetScheduler safetyNetScheduler,
                      AskUserQuestionVisualNotifier askUserQuestionVisualNotifier,
                      AskUserQuestionSoundNotifier askUserQuestionSoundNotifier) {
        this(context, safetyNetScheduler, DEFAULT_EDT_DISPATCHER,
                askUserQuestionVisualNotifier, askUserQuestionSoundNotifier);
    }

    PermissionHandler(HandlerContext context, SafetyNetScheduler safetyNetScheduler,
                      EdtDispatcher edtDispatcher,
                      AskUserQuestionVisualNotifier askUserQuestionVisualNotifier,
                      AskUserQuestionSoundNotifier askUserQuestionSoundNotifier) {
        super(context);
        this.safetyNetScheduler = safetyNetScheduler;
        this.edtDispatcher = edtDispatcher;
        this.askUserQuestionVisualNotifier = askUserQuestionVisualNotifier;
        this.askUserQuestionSoundNotifier = askUserQuestionSoundNotifier;
    }

    long getDialogTimeoutSeconds() {
        CodemossSettingsService settingsService = context.getSettingsService();
        if (settingsService == null) {
            return CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
        }
        try {
            return settingsService.getPermissionDialogTimeoutSeconds();
        } catch (Exception e) {
            LOG.warn("[PERM_SHOW] Failed to read permission dialog timeout; errorClass="
                    + e.getClass().getSimpleName(), e);
            return CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;
        }
    }

    long getSafetyNetTimeoutSeconds() {
        return getDialogTimeoutSeconds()
                + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS;
    }

    private long dialogDeadlineMs() {
        return System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(getDialogTimeoutSeconds());
    }

    private long nextDialogSequence() {
        return nextDialogSequence.incrementAndGet();
    }

    void scheduleSafetyNet(CompletableFuture<?> future, Runnable timeoutTask) {
        CancellableTask cancellableTask = safetyNetScheduler.schedule(timeoutTask, getSafetyNetTimeoutSeconds());
        future.whenComplete((ignored, error) -> cancellableTask.cancel());
    }

    /**
     * Push a force-close signal to the webview's dialog manager. Used after the
     * Java side has auto-resolved a permission/ask/plan dialog future (e.g.
     * safety-net timeout) so the React dialog state cannot stay stuck on a
     * resolved request and silently block every subsequent show*Dialog call.
     *
     * @param fnName           webview function: forceClosePermissionDialog /
     *                         forceCloseAskUserQuestionDialog /
     *                         forceClosePlanApprovalDialog
     * @param targetId         channelId (permission) or requestId (ask/plan);
     *                         null clears every open dialog of that kind.
     * @param dialogToken      request identity preventing a delayed close from affecting a new request with the same ID.
     */
    private void forceCloseFrontendDialog(String fnName, String targetId, String dialogToken) {
        String safeId = targetId == null ? "" : targetId;
        recordUndeliveredCloseSignal(fnName, safeId, dialogToken);
        injectForceCloseJs(fnName, safeId, dialogToken);
    }

    /**
     * Replays pending dialog commands after a frontend page becomes ready.
     */
    public void replayPendingDialogsToWebview() {
        flushUndeliveredCloseSignals();

        List<DialogReplay> replays = new ArrayList<>();
        synchronized (dialogLock) {
            for (Map.Entry<String, PendingDialogShow<Integer>> entry : pendingPermissionRequests.entrySet()) {
                replays.add(permissionReplay(entry.getKey(), entry.getValue()));
            }
            for (Map.Entry<String, PendingLegacyPermission> entry : pendingLegacyPermissionRequests.entrySet()) {
                replays.add(legacyPermissionReplay(entry.getKey(), entry.getValue()));
            }
            for (Map.Entry<String, PendingDialogShow<JsonObject>> entry : pendingAskUserQuestionRequests.entrySet()) {
                replays.add(askUserQuestionReplay(entry.getKey(), entry.getValue()));
            }
            for (Map.Entry<String, PendingDialogShow<JsonObject>> entry : pendingPlanApprovalRequests.entrySet()) {
                replays.add(planApprovalReplay(entry.getKey(), entry.getValue()));
            }
        }
        replays.sort(Comparator.comparingLong(DialogReplay::sequence));

        for (DialogReplay replay : replays) {
            try {
                injectDialogShowJs(replay);
            } catch (RuntimeException e) {
                LOG.warn("[PERM_REPLAY] Failed to enqueue dialog replay for requestKey="
                        + replay.requestKey + ": " + e.getMessage(), e);
            }
        }
        if (!replays.isEmpty()) {
            LOG.info("[PERM_REPLAY] Replayed " + replays.size()
                    + " pending dialog show(s) after frontend ready");
        }
    }

    private DialogReplay permissionReplay(String requestKey, PendingDialogShow<Integer> pending) {
        return new DialogReplay(
                "showPermissionDialog", requestKey, pendingPermissionRequests, pending, null);
    }

    private DialogReplay legacyPermissionReplay(String requestKey, PendingLegacyPermission legacy) {
        return new DialogReplay(
                "showPermissionDialog", requestKey, pendingLegacyPermissionRequests, null, legacy);
    }

    private DialogReplay askUserQuestionReplay(String requestKey, PendingDialogShow<JsonObject> pending) {
        return new DialogReplay(
                "showAskUserQuestionDialog", requestKey, pendingAskUserQuestionRequests, pending, null);
    }

    private DialogReplay planApprovalReplay(String requestKey, PendingDialogShow<JsonObject> pending) {
        return new DialogReplay(
                "showPlanApprovalDialog", requestKey, pendingPlanApprovalRequests, pending, null);
    }

    private void recordUndeliveredCloseSignal(String fnName, String targetId, String dialogToken) {
        synchronized (dialogLock) {
            // Coalesce only the same request; closes for other requests reusing its ID must survive.
            undeliveredCloseSignals.removeIf(signal -> signal.functionName.equals(fnName)
                    && signal.targetId.equals(targetId)
                    && Objects.equals(signal.dialogToken, dialogToken));
            while (undeliveredCloseSignals.size() >= MAX_UNDELIVERED_CLOSE_SIGNALS) {
                undeliveredCloseSignals.pollFirst();
            }
            undeliveredCloseSignals.addLast(new UndeliveredCloseSignal(fnName, targetId, dialogToken));
        }
    }

    private void safeForceCloseFrontendDialog(String fnName, String targetId, String dialogToken) {
        try {
            forceCloseFrontendDialog(fnName, targetId, dialogToken);
        } catch (RuntimeException e) {
            LOG.warn("[PERM_REPLAY] Failed to enqueue force-close dialog command: " + e.getMessage(), e);
        }
    }

    private void acknowledgeCloseSignal(String fnName, String targetId, String dialogToken) {
        synchronized (dialogLock) {
            undeliveredCloseSignals.removeIf(signal -> signal.functionName.equals(fnName)
                    && signal.targetId.equals(targetId)
                    && Objects.equals(signal.dialogToken, dialogToken));
        }
    }

    private void flushUndeliveredCloseSignals() {
        List<UndeliveredCloseSignal> signals;
        synchronized (dialogLock) {
            if (undeliveredCloseSignals.isEmpty()) {
                return;
            }
            signals = new ArrayList<>(undeliveredCloseSignals);
        }
        for (UndeliveredCloseSignal signal : signals) {
            try {
                injectForceCloseJs(signal.functionName, signal.targetId, signal.dialogToken);
            } catch (RuntimeException e) {
                LOG.warn("[PERM_REPLAY] Failed to enqueue close replay for targetId="
                        + signal.targetId + ": " + e.getMessage(), e);
            }
        }
        LOG.info("[PERM_REPLAY] Replayed " + signals.size() + " undelivered close signal(s)");
    }

    private void injectDialogShowJs(DialogReplay replay) {
        String jsCode = buildDialogShowScript(replay.functionName, replay.escapedJson());
        edtDispatcher.post(() -> {
            synchronized (dialogLock) {
                if (!replay.isStillPending()) {
                    LOG.debug("[PERM_REPLAY] Skipping stale " + replay.functionName
                            + " for requestKey=" + replay.requestKey);
                    return;
                }
            }
            context.executeJavaScriptQueued(jsCode);
        });
    }

    private static String dialogKind(String functionName) {
        if (functionName.contains("AskUserQuestion")) {
            return "askUserQuestion";
        }
        if (functionName.contains("PlanApproval")) {
            return "planApproval";
        }
        return "permission";
    }

    private String buildDialogShowScript(String webviewFunction, String escapedJson) {
        // Preserve order before callbacks are installed; independent retry timers could move show past close.
        return "(function() { " +
            "if (typeof window." + webviewFunction + " === 'function') { " +
            "window." + webviewFunction + "('" + escapedJson + "'); " +
            "} else { (window.__pendingDialogEvents = window.__pendingDialogEvents || []).push({" +
            "kind: '" + dialogKind(webviewFunction) + "', type: 'show', payload: '" + escapedJson + "'}); } " +
            "})();";
    }

    private void injectForceCloseJs(String fnName, String targetId, String dialogToken) {
        String escapedId = escapeJs(targetId);
        String tokenJson = GSON.toJson(dialogToken);
        String jsCode = "(function() { " +
            "if (typeof window." + fnName + " === 'function') { " +
            "window." + fnName + "('" + escapedId + "', " + tokenJson + "); " +
            "} else { (window.__pendingDialogEvents = window.__pendingDialogEvents || []).push({" +
            "kind: '" + dialogKind(fnName) + "', type: 'close', targetId: '" + escapedId + "', dialogToken: " + tokenJson + "}); } " +
            "})();";
        // The frontend sends ACK after consuming the close; entering the bootstrap buffer does not mean it was closed.
        edtDispatcher.post(() -> context.executeJavaScriptQueued(jsCode));
    }

    public void setPermissionDeniedCallback(PermissionDeniedCallback callback) {
        this.deniedCallback = callback;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("permission_decision".equals(type)) {
            LOG.debug("[PERM_DEBUG][BRIDGE_RECV] Received permission_decision from JS");
            LOG.debug("[PERM_DEBUG][BRIDGE_RECV] payloadLength=" + payloadLength(content));
            handlePermissionDecision(content);
            return true;
        } else if ("ask_user_question_response".equals(type)) {
            LOG.debug("[ASK_USER_QUESTION][BRIDGE_RECV] Received ask_user_question_response from JS");
            LOG.debug("[ASK_USER_QUESTION][BRIDGE_RECV] payloadLength=" + payloadLength(content));
            handleAskUserQuestionResponse(content);
            return true;
        } else if ("plan_approval_response".equals(type)) {
            LOG.debug("[PLAN_APPROVAL][BRIDGE_RECV] Received plan_approval_response from JS");
            LOG.debug("[PLAN_APPROVAL][BRIDGE_RECV] payloadLength=" + payloadLength(content));
            handlePlanApprovalResponse(content);
            return true;
        } else if (DIALOG_DELIVERY_ACK_TYPE.equals(type)) {
            handleDialogDeliveryAck(content);
            return true;
        }
        return false;
    }

    private static String responseToken(JsonObject response) {
        return response.has("dialogToken") && !response.get("dialogToken").isJsonNull()
                ? response.get("dialogToken").getAsString() : null;
    }

    private void handleDialogDeliveryAck(String jsonContent) {
        try {
            JsonObject acknowledgement = GSON.fromJson(jsonContent, JsonObject.class);
            // Only backend-issued request tokens need acknowledgement; local unversioned close-all signals do not.
            if (acknowledgement == null || responseToken(acknowledgement) == null
                    || !acknowledgement.has("targetId") || acknowledgement.get("targetId").isJsonNull()) {
                return;
            }
            acknowledgeCloseSignal(
                    acknowledgement.get("functionName").getAsString(),
                    acknowledgement.get("targetId").getAsString(),
                    responseToken(acknowledgement));
        } catch (Exception e) {
            LOG.warn("[PERM_REPLAY] Failed to parse dialog delivery acknowledgement: "
                    + e.getMessage(), e);
        }
    }

    /**
     * Show the frontend permission dialog.
     */
    public CompletableFuture<Integer> showFrontendPermissionDialog(String toolName, JsonObject inputs) {
        String channelId = UUID.randomUUID().toString();
        CompletableFuture<Integer> future = new CompletableFuture<>();

        LOG.info("[PERM_SHOW] showFrontendPermissionDialog called: channelId=" + channelId + ", toolName=" + toolName);

        try {
            JsonObject requestData = new JsonObject();
            requestData.addProperty("channelId", channelId);
            requestData.addProperty("toolName", toolName);
            requestData.add("inputs", inputs);
            long deadlineMs = dialogDeadlineMs();
            requestData.addProperty("deadlineMs", deadlineMs);
            String dialogToken = UUID.randomUUID().toString();
            requestData.addProperty("dialogToken", dialogToken);

            String requestJson = GSON.toJson(requestData);
            String escapedJson = escapeJs(requestJson);
            PendingDialogShow<Integer> pending = new PendingDialogShow<>(
                    future, escapedJson, nextDialogSequence(), dialogToken);

            synchronized (dialogLock) {
                pendingPermissionRequests.put(channelId, pending);
            }
            LOG.info("[PERM_SHOW] Stored pending request, total pending: " + pendingPermissionRequests.size());

            scheduleSafetyNet(future, () -> {
                if (future.complete(PermissionService.PermissionResponse.DENY.getValue())) {
                    LOG.warn("[PERM_SHOW] Safety-net timeout fired (webview unreachable) for channelId=" + channelId);
                    removePending(pendingPermissionRequests, channelId, pending);

                    safeForceCloseFrontendDialog(
                            "forceClosePermissionDialog", channelId, pending.dialogToken);
                }
            });

            flushUndeliveredCloseSignals();
            injectDialogShowJs(permissionReplay(channelId, pending));

        } catch (Exception e) {
            LOG.error("[PERM_SHOW] ERROR: errorClass=" + errorClass(e), e);
            synchronized (dialogLock) {
                pendingPermissionRequests.remove(channelId);
            }

            future.complete(PermissionService.PermissionResponse.DENY.getValue());
            // No force-close needed: the show script is enqueued last, so any
            // exception here means the dialog was never shown.
        }

        return future;
    }

    /**
     * Show permission request dialog (from PermissionRequest).
     */
    public void showPermissionDialog(PermissionRequest request) {
        LOG.info("[PermissionHandler] 显示权限请求对话框: " + request.getToolName());

        try {
            JsonObject requestData = new JsonObject();
            requestData.addProperty("channelId", request.getChannelId());
            requestData.addProperty("toolName", request.getToolName());

            JsonObject inputsJson = GSON.toJsonTree(request.getInputs()).getAsJsonObject();
            requestData.add("inputs", inputsJson);

            if (request.getSuggestions() != null) {
                requestData.add("suggestions", request.getSuggestions());
            }
            long deadlineMs = dialogDeadlineMs();
            requestData.addProperty("deadlineMs", deadlineMs);
            String dialogToken = UUID.randomUUID().toString();
            requestData.addProperty("dialogToken", dialogToken);

            String requestJson = GSON.toJson(requestData);
            String escapedJson = escapeJs(requestJson);

            // SessionCallbackAdapter already binds the owning tab; a project-level window lookup could route to another tab.
            PendingLegacyPermission pending = new PendingLegacyPermission(
                    request, context.getSession() == null ? null : context.getSession().getPermissionManager(),
                    escapedJson, nextDialogSequence(), dialogToken);
            synchronized (dialogLock) {
                pendingLegacyPermissionRequests.put(request.getChannelId(), pending);
            }
            request.getResultFuture().whenComplete((ignored, error) -> {
                removePending(pendingLegacyPermissionRequests, request.getChannelId(), pending);
                safeForceCloseFrontendDialog("forceClosePermissionDialog", request.getChannelId(), pending.dialogToken);
            });
            scheduleSafetyNet(request.getResultFuture(), () -> {
                if (!request.getResultFuture().isDone()) {
                    resolveLegacyPermission(pending, false, false, "Permission dialog timed out");
                }
            });

            flushUndeliveredCloseSignals();
            injectDialogShowJs(legacyPermissionReplay(request.getChannelId(), pending));
        } catch (Exception e) {
            LOG.error("[PermissionHandler] 显示权限弹窗失败: errorClass=" + errorClass(e), e);
            synchronized (dialogLock) {
                pendingLegacyPermissionRequests.entrySet().removeIf(entry -> entry.getValue().request == request);
            }

            denyLegacyRequest(request, "Failed to show permission dialog");
        }
    }

    private void denyLegacyRequest(PermissionRequest request, String message) {
        request.reject(message, true);
        notifyPermissionDenied();
    }

    private void resolveLegacyPermission(
            PendingLegacyPermission pending,
            boolean allow,
            boolean remember,
            String rejectMessage
    ) {
        if (pending.owner != null) {
            pending.owner.handlePermissionDecision(pending.request, allow, remember, rejectMessage);
        } else if (allow) {
            pending.request.accept();
        } else {
            pending.request.reject(rejectMessage, true);
        }
    }

    /**
     * Handle permission decision messages from JavaScript.
     */
    private void handlePermissionDecision(String jsonContent) {
        LOG.info("[PERM_DECISION] Received permission decision from JS");
        LOG.debug("[PERM_DEBUG][HANDLE_DECISION] payloadLength=" + payloadLength(jsonContent));
        try {
            JsonObject decision = GSON.fromJson(jsonContent, JsonObject.class);

            String channelId = decision.get("channelId").getAsString();
            boolean allow = decision.get("allow").getAsBoolean();
            boolean remember = decision.get("remember").getAsBoolean();
            String rejectMessage = "";
            if (decision.has("rejectMessage") && !decision.get("rejectMessage").isJsonNull()) {
                rejectMessage = decision.get("rejectMessage").getAsString();
            }

            LOG.info("[PERM_DECISION] channelId=" + channelId + ", allow=" + allow + ", remember=" + remember);
            LOG.info("[PERM_DECISION] pendingPermissionRequests size before remove: " + pendingPermissionRequests.size());

            PendingDialogShow<Integer> pending;
            PendingLegacyPermission legacyPending;
            synchronized (dialogLock) {
                pending = pendingPermissionRequests.get(channelId);
                legacyPending = pending == null ? pendingLegacyPermissionRequests.get(channelId) : null;
                String dialogToken = responseToken(decision);
                if ((pending != null && !Objects.equals(pending.dialogToken, dialogToken))
                        || (legacyPending != null && !Objects.equals(legacyPending.dialogToken, dialogToken))) {
                    return;
                }
                pendingPermissionRequests.remove(channelId);
                pendingLegacyPermissionRequests.remove(channelId);
            }

            if (pending != null) {
                LOG.info("[PERM_DECISION] Found pending future, completing with allow=" + allow);
                int responseValue;
                if (allow) {
                    responseValue = remember
                        ? PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue()
                        : PermissionService.PermissionResponse.ALLOW.getValue();
                } else {
                    responseValue = PermissionService.PermissionResponse.DENY.getValue();
                }
                pending.future.complete(responseValue);
                safeForceCloseFrontendDialog(
                        "forceClosePermissionDialog", channelId, pending.dialogToken);
                LOG.info("[PERM_DECISION] Future completed with value=" + responseValue);

                if (!allow) {
                    notifyPermissionDenied();
                }
            } else if (legacyPending != null) {
                LOG.info("[PERM_DECISION] Completing legacy permission request for channelId=" + channelId);
                resolveLegacyPermission(legacyPending, allow, remember, rejectMessage);
                if (!allow) {
                    notifyPermissionDenied();
                }
            }
        } catch (Exception e) {
            LOG.error("[PERM_DECISION] ERROR: errorClass=" + errorClass(e), e);
        }
    }

    /**
     * Notify that permission was denied.
     */
    private void notifyPermissionDenied() {
        if (deniedCallback != null) {
            deniedCallback.onPermissionDenied();
        }
    }

    /**
     * Clear all pending permission requests.
     * Called during session switching or history restoration to prevent old requests from interfering with the new session.
     */
    public void clearPendingRequests() {
        LOG.info("[PERM_CLEAR] Clearing all pending permission requests");

        List<Map.Entry<String, PendingDialogShow<Integer>>> permissionEntries = new ArrayList<>();
        List<Map.Entry<String, PendingLegacyPermission>> legacyEntries = new ArrayList<>();
        List<Map.Entry<String, PendingDialogShow<JsonObject>>> askUserEntries = new ArrayList<>();
        List<Map.Entry<String, PendingDialogShow<JsonObject>>> planEntries = new ArrayList<>();

        synchronized (dialogLock) {
            permissionEntries.addAll(pendingPermissionRequests.entrySet());
            legacyEntries.addAll(pendingLegacyPermissionRequests.entrySet());
            askUserEntries.addAll(pendingAskUserQuestionRequests.entrySet());
            planEntries.addAll(pendingPlanApprovalRequests.entrySet());

            pendingPermissionRequests.clear();
            pendingLegacyPermissionRequests.clear();
            pendingAskUserQuestionRequests.clear();
            pendingPlanApprovalRequests.clear();
        }

        for (Map.Entry<String, PendingDialogShow<Integer>> entry : permissionEntries) {
            entry.getValue().future.complete(PermissionService.PermissionResponse.DENY.getValue());
        }
        for (Map.Entry<String, PendingLegacyPermission> entry : legacyEntries) {
            resolveLegacyPermission(entry.getValue(), false, false, "Session changed");
        }
        for (Map.Entry<String, PendingDialogShow<JsonObject>> entry : askUserEntries) {
            entry.getValue().future.complete(null);
        }
        for (Map.Entry<String, PendingDialogShow<JsonObject>> entry : planEntries) {
            JsonObject rejected = new JsonObject();
            rejected.addProperty("approved", false);
            rejected.addProperty("message", "Session changed");
            entry.getValue().future.complete(rejected);
        }

        for (Map.Entry<String, PendingDialogShow<Integer>> entry : permissionEntries) {
            safeForceCloseFrontendDialog(
                    "forceClosePermissionDialog", entry.getKey(), entry.getValue().dialogToken);
        }
        for (Map.Entry<String, PendingDialogShow<JsonObject>> entry : askUserEntries) {
            safeForceCloseFrontendDialog(
                    "forceCloseAskUserQuestionDialog", entry.getKey(), entry.getValue().dialogToken);
        }
        for (Map.Entry<String, PendingDialogShow<JsonObject>> entry : planEntries) {
            safeForceCloseFrontendDialog(
                    "forceClosePlanApprovalDialog", entry.getKey(), entry.getValue().dialogToken);
        }

        LOG.info("[PERM_CLEAR] Cleared: " + permissionEntries.size() + " permission, "
                + legacyEntries.size() + " legacy permission, " + askUserEntries.size()
                + " askUser, " + planEntries.size() + " plan requests");
    }

    private <T> void removePending(
            Map<String, T> pendingMap,
            String requestKey,
            T expected
    ) {
        synchronized (dialogLock) {
            if (pendingMap.get(requestKey) == expected) {
                pendingMap.remove(requestKey);
            }
        }
    }

    /**
     * Show AskUserQuestion dialog (implements PermissionService.AskUserQuestionDialogShower interface).
     */
    public CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questionsData) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();

        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] Starting showAskUserQuestionDialog");
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] questionCount="
                + (questionsData != null && questionsData.has("questions")
                        && questionsData.get("questions").isJsonArray()
                    ? questionsData.getAsJsonArray("questions").size()
                    : 0));

        try {
            long deadlineMs = dialogDeadlineMs();
            JsonObject requestData = questionsData == null ? new JsonObject() : questionsData.deepCopy();
            requestData.addProperty("requestId", requestId);
            requestData.addProperty("deadlineMs", deadlineMs);
            String dialogToken = UUID.randomUUID().toString();
            requestData.addProperty("dialogToken", dialogToken);
            String requestJson = GSON.toJson(requestData);
            String escapedJson = escapeJs(requestJson);
            PendingDialogShow<JsonObject> pending = new PendingDialogShow<>(
                    future, escapedJson, nextDialogSequence(), dialogToken);

            synchronized (dialogLock) {
                pendingAskUserQuestionRequests.put(requestId, pending);
            }

            // Remind the user (via the opt-in system toast and sound) that Claude is waiting for an
            // answer. Triggered here — before the JS dialog render — so the toast fires
            // for every AskUserQuestion regardless of whether the webview is reachable.
            try {
                askUserQuestionVisualNotifier.remind();
                askUserQuestionSoundNotifier.play();
            } catch (Exception e) {
                LOG.warn("[ASK_USER_QUESTION][SHOW_DIALOG] Failed to show reminder notification: " + e.getMessage());
            }

            scheduleSafetyNet(future, () -> {
                if (future.complete(new JsonObject())) {
                    LOG.warn("[ASK_USER_QUESTION][SHOW_DIALOG] Safety-net timeout fired (webview unreachable) for requestId=" + requestId);
                    removePending(pendingAskUserQuestionRequests, requestId, pending);
                    safeForceCloseFrontendDialog(
                            "forceCloseAskUserQuestionDialog", requestId, pending.dialogToken);
                }
            });

            flushUndeliveredCloseSignals();
            injectDialogShowJs(askUserQuestionReplay(requestId, pending));

        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][SHOW_DIALOG] ERROR: errorClass=" + errorClass(e), e);
            synchronized (dialogLock) {
                pendingAskUserQuestionRequests.entrySet().removeIf(entry -> entry.getKey().equals(requestId) && entry.getValue().future == future);
            }
            future.complete(new JsonObject());
        }

        return future;
    }

    /**
     * Handle AskUserQuestion response messages from JavaScript.
     *
     * <p>A response that does not match the pending request is ignored, but
     * never silently: a stale dialog token used to leave the future untouched
     * until the safety net resolved it with an empty answer, which the bridge
     * forwards as {@code {"answers":[]}} — indistinguishable from the user
     * cancelling. The WARN below is what makes that distinguishable in a log.
     */
    private void handleAskUserQuestionResponse(String jsonContent) {
        LOG.debug("[ASK_USER_QUESTION][HANDLE_RESPONSE] payloadLength=" + payloadLength(jsonContent));
        try {
            JsonObject response = GSON.fromJson(jsonContent, JsonObject.class);

            String requestId = response.get("requestId").getAsString();
            JsonObject answers = response.has("answers") && !response.get("answers").isJsonNull()
                ? response.get("answers").getAsJsonObject()
                : new JsonObject();
            String dialogToken = responseToken(response);

            PendingDialogShow<JsonObject> pendingFuture;
            synchronized (dialogLock) {
                pendingFuture = pendingAskUserQuestionRequests.get(requestId);
                if (pendingFuture != null && !Objects.equals(pendingFuture.dialogToken, dialogToken)) {
                    // Keep the pending request: it belongs to a newer dialog that
                    // reused this request id (session switch, webview reload).
                    LOG.warn("[ASK_USER_QUESTION][HANDLE_RESPONSE] Ignoring a stale response for requestId="
                            + requestId + " (token " + dialogToken + " != pending "
                            + pendingFuture.dialogToken + "); the pending dialog stays open");
                    return;
                }
                if (pendingFuture != null) {
                    pendingAskUserQuestionRequests.remove(requestId);
                }
            }

            if (pendingFuture == null) {
                LOG.warn("[ASK_USER_QUESTION][HANDLE_RESPONSE] No pending request for requestId="
                        + requestId + " (already answered, cleared, or timed out) — ignoring the response");
                return;
            }

            LOG.debug("[ASK_USER_QUESTION][HANDLE_RESPONSE] Completing future with answerCount=" + answers.size());
            pendingFuture.future.complete(answers);
            safeForceCloseFrontendDialog(
                    "forceCloseAskUserQuestionDialog", requestId, pendingFuture.dialogToken);
        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][HANDLE_RESPONSE] ERROR: errorClass=" + errorClass(e), e);
        }
    }

    /**
     * Show PlanApproval dialog (implements PermissionService.PlanApprovalDialogShower interface).
     */
    public CompletableFuture<JsonObject> showPlanApprovalDialog(String requestId, JsonObject planData) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();

        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] Starting showPlanApprovalDialog");
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] fieldCount="
                + (planData == null ? 0 : planData.size()));

        try {
            long deadlineMs = dialogDeadlineMs();
            JsonObject requestData = planData == null ? new JsonObject() : planData.deepCopy();
            requestData.addProperty("requestId", requestId);
            requestData.addProperty("deadlineMs", deadlineMs);
            String dialogToken = UUID.randomUUID().toString();
            requestData.addProperty("dialogToken", dialogToken);
            String requestJson = GSON.toJson(requestData);
            String escapedJson = escapeJs(requestJson);
            PendingDialogShow<JsonObject> pending = new PendingDialogShow<>(
                    future, escapedJson, nextDialogSequence(), dialogToken);

            synchronized (dialogLock) {
                pendingPlanApprovalRequests.put(requestId, pending);
            }

            scheduleSafetyNet(future, () -> {
                JsonObject timeoutResponse = new JsonObject();
                timeoutResponse.addProperty("approved", false);
                timeoutResponse.addProperty("targetMode", "default");
                timeoutResponse.addProperty("message", "Plan approval timed out");
                if (future.complete(timeoutResponse)) {
                    LOG.warn("[PLAN_APPROVAL][SHOW_DIALOG] Safety-net timeout fired (webview unreachable) for requestId=" + requestId);
                    removePending(pendingPlanApprovalRequests, requestId, pending);
                    safeForceCloseFrontendDialog(
                            "forceClosePlanApprovalDialog", requestId, pending.dialogToken);
                }
            });

            flushUndeliveredCloseSignals();
            injectDialogShowJs(planApprovalReplay(requestId, pending));

        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][SHOW_DIALOG] ERROR: errorClass=" + errorClass(e), e);
            synchronized (dialogLock) {
                pendingPlanApprovalRequests.entrySet().removeIf(entry -> entry.getKey().equals(requestId) && entry.getValue().future == future);
            }
            JsonObject errorResponse = new JsonObject();
            errorResponse.addProperty("approved", false);
            errorResponse.addProperty("targetMode", "default");
            errorResponse.addProperty("message", "Error showing plan approval dialog");
            future.complete(errorResponse);
        }

        return future;
    }

    /**
     * Handle PlanApproval response messages from JavaScript.
     */
    private void handlePlanApprovalResponse(String jsonContent) {
        LOG.debug("[PLAN_APPROVAL][HANDLE_RESPONSE] payloadLength=" + payloadLength(jsonContent));
        try {
            JsonObject response = GSON.fromJson(jsonContent, JsonObject.class);

            String requestId = response.get("requestId").getAsString();
            boolean approved = response.has("approved") && response.get("approved").getAsBoolean();
            String targetMode = response.has("targetMode") ? response.get("targetMode").getAsString() : "default";

            PendingDialogShow<JsonObject> pendingFuture;
            synchronized (dialogLock) {
                pendingFuture = pendingPlanApprovalRequests.get(requestId);
                if (pendingFuture == null || !Objects.equals(pendingFuture.dialogToken, responseToken(response))) {
                    return;
                }
                pendingPlanApprovalRequests.remove(requestId);
            }

            JsonObject result = new JsonObject();
            result.addProperty("approved", approved);
            result.addProperty("targetMode", targetMode);
            LOG.debug("[PLAN_APPROVAL][HANDLE_RESPONSE] Completing future: approved=" + approved + ", targetMode=" + targetMode);
            pendingFuture.future.complete(result);
            safeForceCloseFrontendDialog(
                    "forceClosePlanApprovalDialog", requestId, pendingFuture.dialogToken);
        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][HANDLE_RESPONSE] ERROR: errorClass=" + errorClass(e), e);
        }
    }
}
