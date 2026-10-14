package com.github.claudecodegui.clawbot;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Application-scoped leader runtime for the transport-neutral Claw Bot gateway. */
@Service(Service.Level.APP)
public final class ClawBotGatewayRuntimeService implements Disposable {

    private static final Logger LOG = Logger.getInstance(ClawBotGatewayRuntimeService.class);

    private static final String LOOPBACK_ENDPOINT_PREFIX = "loopback://";
    private static final int MAX_PAIRING_QR_LENGTH = 32 * 1024;
    private static final long TAKEOVER_INITIAL_DELAY_SECONDS = 1L;
    private static final long TAKEOVER_PERIOD_SECONDS = 1L;
    private static final long INBOUND_POLL_RETRY_DELAY_MILLIS = 1_000L;
    private static final long INBOUND_POLL_MAX_BACKOFF_MILLIS = 60_000L;
    private static final long PROGRESS_SETTINGS_REFRESH_INTERVAL_NANOS = TimeUnit.SECONDS.toNanos(1);

    private final Path runtimeDirectory;
    private final String instanceId;
    private final long connectionEpoch;
    private final ClawBotProcessCoordinator processCoordinator;
    private final ClawBotIpcSecretStore secretStore;
    private final ClawBotSessionRegistry sessionRegistry;
    private final MockClawBotChannel mockChannel;
    private final ClawBotBindingHandoff bindingHandoff;
    private final ClawBotTransportStateStore transportStateStore;
    private final ClawBotExecutionJournal executionJournal;
    private final ClawBotOutboundReceiptStore outboundReceiptStore;
    private final ClawBotProgressSettingsStore progressSettingsStore;
    private final ClawBotOutboundProtection outboundProtection;
    private final ClawBotPendingDeliveryStore pendingDeliveries;
    private final ClawBotPendingDeliveryStore replyCapabilities;
    private final ClawBotReplyRecoveryStore replyRecovery;
    private final Set<String> deliveriesInFlight = ConcurrentHashMap.newKeySet();
    private final Map<String, Long> deliveryRetryAt = new ConcurrentHashMap<>();
    private ScheduledFuture<?> deliveryRetryTask;
    private final ScheduledExecutorService deliveryExecutor = Executors.newSingleThreadScheduledExecutor(
            daemonThreadFactory("clawbot-delivery-"));
    private final ClawBotSenderAccessStore senderAccessStore;
    private final ScheduledExecutorService takeoverExecutor;
    private final ScheduledExecutorService transportExecutor;
    private final ThreadPoolExecutor replyExecutor;
    private final ClawBotMessageRouter messageRouter;
    private final ClawBotPreviewMailbox previewMailbox = new ClawBotPreviewMailbox();
    private final Set<String> deliveredProgressEvents = ConcurrentHashMap.newKeySet();
    private final Set<String> progressEventsInFlight = ConcurrentHashMap.newKeySet();
    private final Map<String, String> outboundEventStates = new ConcurrentHashMap<>();
    private final Set<String> terminalRepliesInFlight = ConcurrentHashMap.newKeySet();
    private final Set<String> controlRepliesInFlight = ConcurrentHashMap.newKeySet();
    private volatile State state = State.STOPPED;
    private ClawBotProcessCoordinator.LeaderLease leaderLease;
    private ClawBotLocalIpcServer ipcServer;
    private ClawBotLocalIpcServer.Endpoint endpoint;
    private ClawBotIlinkProcess ilinkProcess;
    private JsonObject pairingSnapshot = idlePairingSnapshot();
    private int pairingAttempt;
    private boolean transportActive;
    private long outboundGeneration;
    private volatile String inboundCursor = "";
    private volatile long inboundPollCount;
    private volatile long inboundMessageCount;
    private volatile long inboundDroppedCount;
    private volatile String inboundLastError = "";
    private volatile long inboundLastPollAt;
    private volatile long inboundLastSuccessAt;
    private volatile long outboundLastSuccessAt;
    private volatile String outboundLastError = "";
    private volatile ClawBotProgressSettings progressSettings;
    private volatile long progressSettingsLastRefreshNanos;
    private ScheduledFuture<?> takeoverTask;
    private ScheduledFuture<?> routeSweepTask;
    private ScheduledFuture<?> inboundPollTask;
    private ScheduledFuture<?> transportRestartTask;
    private long inboundPollBackoffMillis = INBOUND_POLL_RETRY_DELAY_MILLIS;
    private boolean disposed;

    public ClawBotGatewayRuntimeService() {
        this(ClawBotProcessCoordinator.defaultRuntimeDirectory(), UUID.randomUUID().toString(),
                new ClawBotBindingHandoff(), new ClawBotSenderAccessStore(),
                new ClawBotConversationRouteStore());
    }

    ClawBotGatewayRuntimeService(Path runtimeDirectory, String instanceId) {
        this(runtimeDirectory, instanceId, new ClawBotBindingHandoff());
    }

    ClawBotGatewayRuntimeService(
            Path runtimeDirectory, String instanceId, ClawBotBindingHandoff bindingHandoff) {
        this(runtimeDirectory, instanceId, bindingHandoff,
                new ClawBotSenderAccessStore(inMemorySecretBackend()),
                new ClawBotConversationRouteStore(inMemorySecretBackend()));
    }

    ClawBotGatewayRuntimeService(
            Path runtimeDirectory,
            String instanceId,
            ClawBotBindingHandoff bindingHandoff,
            ClawBotSenderAccessStore senderAccessStore,
            ClawBotConversationRouteStore routeStore) {
        this.runtimeDirectory = runtimeDirectory.toAbsolutePath().normalize();
        this.instanceId = requireValue(instanceId, "instanceId");
        this.bindingHandoff = Objects.requireNonNull(bindingHandoff, "bindingHandoff");
        this.senderAccessStore = Objects.requireNonNull(senderAccessStore, "senderAccessStore");
        this.progressSettingsStore = new ClawBotProgressSettingsStore(this.runtimeDirectory);
        this.outboundProtection = new ClawBotOutboundProtection(this.runtimeDirectory);
        this.pendingDeliveries = new ClawBotPendingDeliveryStore(this.runtimeDirectory);
        this.replyCapabilities = new ClawBotPendingDeliveryStore(this.runtimeDirectory, "reply-capabilities.enc");
        this.replyRecovery = new ClawBotReplyRecoveryStore(this.runtimeDirectory);
        this.progressSettings = loadProgressSettings();
        this.messageRouter = new ClawBotMessageRouter(
                Objects.requireNonNull(routeStore, "routeStore"), new ClawBotMessageRouter.SenderUsageRecorder() {
                    @Override
                    public boolean test(String senderId) {
                        return senderAccessStore.isAllowed(senderId);
                    }

                    @Override
                    public void recordUse(String senderId) {
                        try {
                            takeoverExecutor.execute(() -> senderAccessStore.recordUse(senderId));
                        } catch (RejectedExecutionException ignored) {
                            // Usage metadata is diagnostic only.
                        }
                    }
                }, this::progressSettings);
        this.messageRouter.setPreviewRequester(previewMailbox::request);
        this.transportStateStore = new ClawBotTransportStateStore(this.runtimeDirectory);
        this.executionJournal = new ClawBotExecutionJournal(this.runtimeDirectory);
        this.outboundReceiptStore = new ClawBotOutboundReceiptStore(this.runtimeDirectory);
        this.connectionEpoch = Math.max(System.currentTimeMillis(), 1L);
        this.processCoordinator = new ClawBotProcessCoordinator(this.runtimeDirectory, instanceId);
        this.secretStore = new ClawBotIpcSecretStore(this.runtimeDirectory);
        this.sessionRegistry = new ClawBotSessionRegistry();
        this.mockChannel = new MockClawBotChannel();
        this.takeoverExecutor = Executors.newSingleThreadScheduledExecutor(
                daemonThreadFactory("clawbot-takeover-"));
        this.transportExecutor = Executors.newSingleThreadScheduledExecutor(
                daemonThreadFactory("clawbot-transport-"));
        this.replyExecutor = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(256), daemonThreadFactory("clawbot-reply-"),
                ClawBotGatewayRuntimeService::runRejectedReplyOnCaller);
    }

    public static ClawBotGatewayRuntimeService getInstance() {
        return ApplicationManager.getApplication().getService(ClawBotGatewayRuntimeService.class);
    }

    /** Returns the current progress intervals; the value changes when the Settings panel saves them. */
    public ClawBotProgressSettings progressSettings() {
        refreshFollowerProgressSettings();
        return progressSettings;
    }

    /** Starts the gateway or joins the existing leader as a follower. */
    public synchronized boolean start() throws IOException {
        ensureNotDisposed();
        if (state == State.LEADER) {
            return true;
        }
        if (state == State.FOLLOWER) {
            return false;
        }
        if (tryBecomeLeader()) {
            return true;
        }
        state = State.FOLLOWER;
        scheduleTakeover();
        return false;
    }

    /** Attempts an immediate follower takeover, primarily for lifecycle and integration tests. */
    public synchronized boolean attemptTakeover() throws IOException {
        ensureNotDisposed();
        if (state == State.LEADER) {
            return true;
        }
        if (state == State.STOPPED) {
            return start();
        }
        return tryBecomeLeader();
    }

    public synchronized boolean isLeader() {
        return state == State.LEADER;
    }

    /** Returns only non-sensitive local gateway diagnostics for the Settings view. */
    public synchronized JsonObject statusSnapshot() {
        if (state == State.FOLLOWER) {
            try {
                JsonObject leaderStatus = requestLeaderStatus();
                syncProgressSettings(leaderStatus);
                // The counters belong to the leader, but the role shown in this IDE must
                // describe the local gateway instance. Otherwise every follower appears as
                // another leader in its Settings view.
                leaderStatus.addProperty("state", state.name());
                return leaderStatus;
            } catch (IOException | RuntimeException ignored) {
                // The local snapshot remains useful while the leader is restarting.
            }
        }
        return localStatusSnapshot();
    }

    private synchronized JsonObject localStatusSnapshot() {
        JsonObject status = new JsonObject();
        status.addProperty("state", state.name());
        recoverTransportIfProcessStopped();
        status.addProperty("transport", transportActive ? "ILINK" : "MOCK");
        status.addProperty("transportState", transportActive ? "READY" : "STOPPED");
        ClawBotProgressSettings currentProgressSettings = progressSettings;
        status.addProperty("progressTextIntervalMinutes", currentProgressSettings.textIntervalMinutes());
        status.addProperty("progressIdleReminderMinutes", currentProgressSettings.idleReminderMinutes());
        status.addProperty("progressWaitReminderMinutes", currentProgressSettings.waitReminderMinutes());
        status.addProperty("progressInitialCheckDelaySeconds", currentProgressSettings.initialCheckDelaySeconds());
        status.addProperty("progressMaxNotifications", currentProgressSettings.maxNotifications());
        status.addProperty("progressExcerptMaxCharacters", currentProgressSettings.excerptMaxCharacters());
        status.addProperty("progressMinSendIntervalSeconds", currentProgressSettings.minSendIntervalSeconds());
        try {
            status.addProperty("outboundNextAllowedAt", outboundProtection.nextAllowedAt(System.currentTimeMillis()));
            status.addProperty("outboundQueuedCount", pendingDeliveries.pending(deliveryToken()).stream().filter(value -> !value.unknown()).count());
        } catch (IOException | RuntimeException ignored) {
            status.addProperty("outboundQueuedCount", 0);
        }
        status.addProperty("sessionIdleTimeoutMinutes", currentProgressSettings.sessionIdleTimeoutMinutes());
        status.addProperty("transportRecoveryScheduled", transportRestartTask != null
                && !transportRestartTask.isDone());
        status.addProperty("sessionCount", state == State.LEADER ? sessionRegistry.snapshot().size() : 0);
        status.addProperty("senderAccessCount", senderAccessStore.count());
        status.addProperty("senderAccessStoreAvailable", senderAccessStore.available());
        ClawBotOutboundReceiptStore.StatusSnapshot receipts = state == State.LEADER
                ? outboundReceiptStore.status() : outboundReceiptStore.readOnlyStatus();
        status.addProperty("outboundReceiptStoreAvailable", receipts.available());
        status.addProperty("outboundPendingCount", receipts.pendingCount());
        status.addProperty("outboundSentCount", receipts.sentCount());
        status.addProperty("outboundUnknownCount", receipts.unknownCount());
        status.addProperty("outboundFailedCount", receipts.failedCount());
        status.addProperty("outboundLatestStatus", receipts.latestStatus());
        status.addProperty("outboundLatestError", receipts.latestErrorCode());
        ClawBotBindingHandoff.BindingSnapshot binding = bindingHandoff.status();
        status.addProperty("bindingState", binding.state());
        status.addProperty("bindingRevision", binding.revision());
        status.addProperty("bindingDiagnostic", binding.diagnostic());
        String pairingState = readStringOrDefault(pairingSnapshot, "state", "IDLE");
        status.addProperty("pairingState", pairingState);
        JsonElement expiresAt = pairingSnapshot.get("expiresAt");
        status.add("pairingExpiresAt", expiresAt == null ? com.google.gson.JsonNull.INSTANCE : expiresAt.deepCopy());
        status.addProperty("pairingAttempt", isActivePairingState(pairingState) ? pairingAttempt : 0);
        status.addProperty("inboundPollCount", inboundPollCount);
        status.addProperty("inboundMessageCount", inboundMessageCount);
        status.addProperty("inboundDroppedCount", inboundDroppedCount);
        status.addProperty("inboundUncertainCount", messageRouter.uncertainMessageIdsSnapshot().size());
        ClawBotExecutionJournal.StatusSnapshot executions = state == State.LEADER
                ? executionJournal.status() : new ClawBotExecutionJournal.StatusSnapshot(false, 0, 0, 0, 0);
        status.addProperty("executionJournalAvailable", executions.available());
        status.addProperty("executionAcceptedCount", executions.acceptedCount());
        status.addProperty("executionDispatchedCount", executions.dispatchedCount());
        status.addProperty("executionCompletedCount", executions.completedCount());
        status.addProperty("executionUnknownCount", executions.unknownCount());
        status.addProperty("inboundLastPollAt", inboundLastPollAt);
        status.addProperty("inboundLastSuccessAt", inboundLastSuccessAt);
        status.addProperty("inboundPollBackoffMillis", inboundPollBackoffMillis);
        status.addProperty("inboundLastError", inboundLastError);
        status.addProperty("outboundLastSuccessAt", outboundLastSuccessAt);
        status.addProperty("outboundLastError", outboundLastError);
        status.add("pairing", pairingSnapshot.deepCopy());
        return status;
    }

    private JsonObject requestLeaderStatus() throws IOException {
        ClawBotIpcEnvelope request = new ClawBotIpcEnvelope(
                ClawBotIpcEnvelope.PROTOCOL_VERSION,
                "CLAWBOT_STATUS",
                UUID.randomUUID().toString(),
                instanceId,
                connectionEpoch,
                new JsonObject());
        ClawBotIpcEnvelope response = new ClawBotLocalIpcClient(
                resolveLeaderEndpoint(), instanceId, connectionEpoch).request(request);
        if ("ERROR".equals(response.type())) {
            throw new IOException(readErrorCode(response.payload()));
        }
        if (!"CLAWBOT_STATUS_RESULT".equals(response.type())) {
            throw new IOException("CLAWBOT_STATUS_RESPONSE_INVALID");
        }
        return response.payload();
    }

    /** Executes an iLink control operation on the application-scoped Leader. */
    public synchronized JsonObject control(String operation, JsonObject params) throws IOException {
        ensureNotDisposed();
        String normalizedOperation = requireControlOperation(operation);
        if (state == State.STOPPED) {
            throw new IOException("CLAWBOT_GATEWAY_NOT_STARTED");
        }
        if (state == State.LEADER) {
            return handleControl(normalizedOperation, params == null ? new JsonObject() : params);
        }
        JsonObject requestPayload = params == null ? new JsonObject() : params.deepCopy();
        ClawBotIpcEnvelope request = new ClawBotIpcEnvelope(
                ClawBotIpcEnvelope.PROTOCOL_VERSION,
                "CLAWBOT_" + normalizedOperation,
                UUID.randomUUID().toString(),
                instanceId,
                connectionEpoch,
                requestPayload);
        ClawBotIpcEnvelope response = new ClawBotLocalIpcClient(
                resolveLeaderEndpoint(), instanceId, connectionEpoch).request(request);
        if ("ERROR".equals(response.type())) {
            throw new IOException(readErrorCode(response.payload()));
        }
        JsonObject localResponse = withLocalState(response.payload());
        syncProgressSettings(localResponse);
        return localResponse;
    }

    private synchronized JsonObject withLocalState(JsonObject remoteStatus) {
        JsonObject status = remoteStatus == null ? new JsonObject() : remoteStatus.deepCopy();
        status.addProperty("state", state.name());
        return status;
    }

    private void syncProgressSettings(JsonObject status) {
        if (status == null || !status.has("progressTextIntervalMinutes")
                || !status.has("progressIdleReminderMinutes")
                || !status.has("progressWaitReminderMinutes")) {
            return;
        }
        JsonObject settings = new JsonObject();
        settings.add("textIntervalMinutes", status.get("progressTextIntervalMinutes"));
        settings.add("idleReminderMinutes", status.get("progressIdleReminderMinutes"));
        settings.add("waitReminderMinutes", status.get("progressWaitReminderMinutes"));
        copyIfPresent(status, settings, "progressInitialCheckDelaySeconds", "initialCheckDelaySeconds");
        copyIfPresent(status, settings, "progressMaxNotifications", "maxNotifications");
        copyIfPresent(status, settings, "progressExcerptMaxCharacters", "excerptMaxCharacters");
        copyIfPresent(status, settings, "progressMinSendIntervalSeconds", "minSendIntervalSeconds");
        copyIfPresent(status, settings, "sessionIdleTimeoutMinutes", "sessionIdleTimeoutMinutes");
        try {
            progressSettings = ClawBotProgressSettings.fromUpdatePayload(settings, progressSettings);
            progressSettingsLastRefreshNanos = System.nanoTime();
        } catch (IOException | IllegalArgumentException ignored) {
            // Keep the last valid local value if a newer peer sends an invalid payload.
        }
    }

    private static void copyIfPresent(JsonObject source, JsonObject target, String sourceName, String targetName) {
        JsonElement value = source.get(sourceName);
        if (value != null && !value.isJsonNull()) {
            target.add(targetName, value.deepCopy());
        }
    }

    private void refreshFollowerProgressSettings() {
        if (state != State.FOLLOWER) {
            return;
        }
        long now = System.nanoTime();
        if (progressSettingsLastRefreshNanos != 0L
                && now - progressSettingsLastRefreshNanos < PROGRESS_SETTINGS_REFRESH_INTERVAL_NANOS) {
            return;
        }
        synchronized (this) {
            if (state != State.FOLLOWER || (progressSettingsLastRefreshNanos != 0L
                    && now - progressSettingsLastRefreshNanos < PROGRESS_SETTINGS_REFRESH_INTERVAL_NANOS)) {
                return;
            }
            progressSettingsLastRefreshNanos = now;
            try {
                progressSettings = progressSettingsStore.load();
            } catch (IOException | RuntimeException ignored) {
                // Keep the last valid value while the leader is rotating or the file is unavailable.
            }
        }
    }

    /** Creates an IDE client using this runtime's leader or the discovered leader endpoint. */
    public synchronized ClawBotIdeClient createIdeClient(String ideInstanceId, long ideConnectionEpoch)
            throws IOException {
        ensureNotDisposed();
        if (state == State.STOPPED) {
            throw new IOException("CLAWBOT_GATEWAY_NOT_STARTED");
        }
        return new ClawBotIdeClient(
                () -> state == State.LEADER ? endpoint : resolveLeaderEndpoint(),
                ideInstanceId,
                ideConnectionEpoch,
                ClawBotIdeClient.DEFAULT_HEARTBEAT_INTERVAL_MILLIS);
    }

    public synchronized ClawBotLocalIpcServer.Endpoint endpoint() {
        if (state != State.LEADER || endpoint == null) {
            throw new IllegalStateException("CLAWBOT_GATEWAY_NOT_LEADER");
        }
        return endpoint;
    }

    public List<ClawBotSessionSnapshot> sessions() {
        return sessionRegistry.snapshot();
    }

    public MockClawBotChannel mockChannel() {
        return mockChannel;
    }

    @Override
    public synchronized void dispose() {
        stop();
    }

    public synchronized void stop() {
        if (disposed) {
            return;
        }
        disposed = true;
        previewMailbox.clear();
        state = State.STOPPED;
        cancelTakeover();
        if (routeSweepTask != null) {
            routeSweepTask.cancel(false);
            routeSweepTask = null;
        }
        cancelTransportRestart();
        if (ipcServer != null) {
            ipcServer.close();
            ipcServer = null;
        }
        closeIlinkProcess();
        endpoint = null;
        closeLease(leaderLease);
        leaderLease = null;
        mockChannel.close();
        takeoverExecutor.shutdownNow();
        transportExecutor.shutdownNow();
        replyExecutor.shutdownNow();
        deliveryExecutor.shutdownNow();
    }

    private boolean tryBecomeLeader() throws IOException {
        if (state == State.LEADER) {
            return true;
        }
        ClawBotTransportStateStore.State transportState = transportStateStore.load();
        ClawBotProcessCoordinator.LeaderLease lease = processCoordinator.tryAcquireLeader(
                LOOPBACK_ENDPOINT_PREFIX + "pending-" + instanceId);
        if (lease == null) {
            return false;
        }
        ClawBotLocalIpcServer server = null;
        try {
            outboundReceiptStore.reload();
            outboundProtection.reload();
            pendingDeliveries.reload();
            replyCapabilities.reload();
            replyRecovery.reload();
            executionJournal.load();
            messageRouter.clear();
            String authToken = secretStore.loadOrCreate();
            server = new ClawBotLocalIpcServer(
                    instanceId,
                    connectionEpoch,
                    authToken,
                    this::handleRequest);
            ClawBotLocalIpcServer.Endpoint localEndpoint = server.start();
            lease.updateEndpoint(formatEndpoint(localEndpoint));
            leaderLease = lease;
            ipcServer = server;
            endpoint = localEndpoint;
            state = State.LEADER;
            if (deliveryRetryTask == null) {
                deliveryRetryTask = deliveryExecutor.scheduleWithFixedDelay(this::retryPendingDeliveries, 5, 5, TimeUnit.SECONDS);
            }
            cancelTakeover();
            if (routeSweepTask != null) {
                routeSweepTask.cancel(false);
            }
            routeSweepTask = takeoverExecutor.scheduleWithFixedDelay(this::sweepRoutes, 5, 5, TimeUnit.SECONDS);
            messageRouter.clearSeenMessages();
            messageRouter.restoreSeenMessageIds(transportState.seenMessageIds());
            messageRouter.restoreUncertainMessageIds(transportState.uncertainMessageIds());
            inboundCursor = transportState.cursor();
            publishCurrentSessions();
            resumeBoundTransport();
            return true;
        } catch (IOException | RuntimeException error) {
            if (server != null) {
                server.close();
            }
            closeLease(lease);
            throw error;
        }
    }

    private void scheduleTakeover() {
        if (takeoverTask != null) {
            return;
        }
        takeoverTask = takeoverExecutor.scheduleWithFixedDelay(
                this::takeoverTick,
                TAKEOVER_INITIAL_DELAY_SECONDS,
                TAKEOVER_PERIOD_SECONDS,
                TimeUnit.SECONDS);
    }

    private void takeoverTick() {
        synchronized (this) {
            if (disposed || state != State.FOLLOWER) {
                return;
            }
            try {
                tryBecomeLeader();
            } catch (IOException | RuntimeException ignored) {
                // Retry on the next bounded tick; no credential or endpoint details are logged.
            }
        }
    }

    private void cancelTakeover() {
        if (takeoverTask != null) {
            takeoverTask.cancel(false);
            takeoverTask = null;
        }
    }

    private ClawBotLocalIpcServer.Endpoint resolveLeaderEndpoint() throws IOException {
        Optional<ClawBotProcessCoordinator.LeaderInfo> leader = processCoordinator.readLeader();
        if (leader.isEmpty() || leader.get().protocolVersion() != ClawBotProcessCoordinator.PROTOCOL_VERSION) {
            throw new IOException("CLAWBOT_GATEWAY_UNAVAILABLE");
        }
        URI uri;
        try {
            uri = URI.create(leader.get().endpoint());
        } catch (IllegalArgumentException error) {
            throw new IOException("CLAWBOT_GATEWAY_ENDPOINT_INVALID", error);
        }
        if (!"loopback".equalsIgnoreCase(uri.getScheme())
                || uri.getHost() == null || !isLoopbackHost(uri.getHost())
                || uri.getPort() < 1 || uri.getPort() > 65535) {
            throw new IOException("CLAWBOT_GATEWAY_ENDPOINT_INVALID");
        }
        return new ClawBotLocalIpcServer.Endpoint(
                uri.getHost(),
                uri.getPort(),
                leader.get().protocolVersion(),
                secretStore.read());
    }

    private void sweepRoutes() {
        List<ClawBotInboundMessage> expiredPreviews;
        synchronized (this) {
            if (disposed || state != State.LEADER) {
                return;
            }
            try {
                recoverTransportIfProcessStopped();
                messageRouter.sweep(sessionRegistry.snapshot());
                expiredPreviews = previewMailbox.sweep(messageRouter::acceptsPending);
            } catch (IOException error) {
                LOG.warn("[ClawBot] Route expiration persistence failed");
                return;
            }
        }
        notifyExpiredPreviews(expiredPreviews);
    }

    private void notifyExpiredPreviews(List<ClawBotInboundMessage> expiredPreviews) {
        for (ClawBotInboundMessage preview : expiredPreviews) {
            try {
                sendChannelText(preview.fromUserId(), preview.contextToken(),
                        "\u6682\u65f6\u65e0\u6cd5\u83b7\u53d6\u4f1a\u8bdd\u6458\u8981\uff0c\u53ef\u53d1\u9001 /status \u91cd\u8bd5\u3002",
                        stableEventId(preview.messageId(), "preview-timeout"), true);
            } catch (IOException error) {
                LOG.debug("[ClawBot] Preview timeout notification unavailable");
            }
        }
    }

    private ClawBotIpcEnvelope handleRequest(ClawBotIpcEnvelope request) {
        try {
            JsonObject payload = request.payload();
            boolean accepted;
            switch (request.type()) {
                case "CLAWBOT_START_PAIRING":
                    return controlResponse(request, "START_PAIRING", payload);
                case "CLAWBOT_POLL_PAIRING":
                    return controlResponse(request, "POLL_PAIRING", payload);
                case "CLAWBOT_CANCEL_PAIRING":
                    return controlResponse(request, "CANCEL_PAIRING", payload);
                case "CLAWBOT_START_TRANSPORT":
                    return controlResponse(request, "START_TRANSPORT", payload);
                case "CLAWBOT_UNBIND":
                    return controlResponse(request, "UNBIND", payload);
                case "CLAWBOT_ALLOW_SENDER":
                    return controlResponse(request, "ALLOW_SENDER", payload);
                case "CLAWBOT_REVOKE_SENDER":
                    return controlResponse(request, "REVOKE_SENDER", payload);
                case "CLAWBOT_LIST_SENDERS":
                    return controlResponse(request, "LIST_SENDERS", payload);
                case "CLAWBOT_UPDATE_PROGRESS_SETTINGS":
                    return controlResponse(request, "UPDATE_PROGRESS_SETTINGS", payload);
                case "CLAWBOT_LIST_REPLY_RECOVERY":
                    return controlResponse(request, "LIST_REPLY_RECOVERY", payload);
                case "CLAWBOT_RETRY_REPLY":
                    return controlResponse(request, "RETRY_REPLY", payload);
                case "CLAWBOT_STATUS":
                    return response(request, "CLAWBOT_STATUS_RESULT", localStatusSnapshot());
                case "SESSION_POLL":
                    requireRequestOwner(request, readString(payload, "instanceId"),
                            readLong(payload, "connectionEpoch"));
                    String sessionHandleId = readString(payload, "sessionHandleId");
                    if (!sessionRegistry.isOwner(sessionHandleId, request.instanceId(), request.connectionEpoch())) {
                        return errorResponse(request, "CLAWBOT_SESSION_NOT_OWNER");
                    }
                    ClawBotInboundMessage message = sessionRegistry.pollInbound(
                            sessionHandleId, request.instanceId(), request.connectionEpoch());
                    JsonObject messagePayload = new JsonObject();
                    if (message != null) {
                        messagePayload.add("message", message.toJson());
                    } else {
                        messagePayload.add("message", com.google.gson.JsonNull.INSTANCE);
                    }
                    return response(request, "SESSION_POLL_RESULT", messagePayload);
                case "SESSION_REPLY":
                    return sessionReplyResponse(request, payload);
                case "SESSION_REJECT":
                    return rejectPendingMessageResponse(request, payload, false);
                case "SESSION_CONTROL_POLL":
                    requireRequestOwner(request, readString(payload, "instanceId"),
                            readLong(payload, "connectionEpoch"));
                    String controlSessionHandleId = readString(payload, "sessionHandleId");
                    if (!sessionRegistry.isOwner(
                            controlSessionHandleId, request.instanceId(), request.connectionEpoch())) {
                        return errorResponse(request, "CLAWBOT_SESSION_CONTROL_NOT_OWNER");
                    }
                    ClawBotInboundMessage command = sessionRegistry.pollCommand(
                            controlSessionHandleId, request.instanceId(), request.connectionEpoch());
                    JsonObject commandPayload = new JsonObject();
                    commandPayload.add("message", command == null
                            ? com.google.gson.JsonNull.INSTANCE : command.toJson());
                    return response(request, "SESSION_CONTROL_POLL_RESULT", commandPayload);
                case "SESSION_CONTROL_VALIDATE":
                    accepted = validatePendingCommand(request, payload);
                    break;
                case "SESSION_CONTROL_REPLY":
                    return sessionControlReplyResponse(request, payload);
                case "SESSION_CONTROL_REJECT":
                    return rejectPendingMessageResponse(request, payload, true);
                case "SESSION_INTERACTION":
                    return sessionInteractionResponse(request, payload);
                case "SESSION_PROGRESS":
                    return sessionProgressResponse(request, payload);
                case "SESSION_PREVIEW_POLL":
                    synchronized (this) {
                        messageRouter.sweep(sessionRegistry.snapshot());
                        previewMailbox.sweep(messageRouter::acceptsPending);
                        String handle = readString(payload, "sessionHandleId");
                        if (!sessionRegistry.isOwner(handle, request.instanceId(), request.connectionEpoch())) {
                            return errorResponse(request, "CLAWBOT_SESSION_NOT_OWNER");
                        }
                        ClawBotInboundMessage preview = previewMailbox.poll(
                                handle, request.instanceId(), request.connectionEpoch());
                        JsonObject result = new JsonObject();
                        result.add("message", preview == null ? com.google.gson.JsonNull.INSTANCE : preview.toJson());
                        return response(request, "SESSION_PREVIEW_POLL_RESULT", result);
                    }
                case "SESSION_PREVIEW_REPLY":
                    return previewReplyResponse(request, payload);
                case "SESSION_VALIDATE":
                    synchronized (this) {
                        messageRouter.sweep(sessionRegistry.snapshot());
                        String handle = readString(payload, "sessionHandleId");
                        String messageId = readBoundedString(
                                payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false);
                        ClawBotInboundMessage pending = sessionRegistry.pollInbound(handle,
                                request.instanceId(), request.connectionEpoch());
                        accepted = pending != null && pending.messageId().equals(
                                messageId) && messageRouter.acceptsPending(pending);
                        if (accepted) {
                            if (pending.action() == ClawBotInboundAction.MESSAGE && transportActive) {
                                queueTaskStart(pending);
                            }
                            accepted = sessionRegistry.markInboundDispatched(
                                    handle, request.instanceId(), request.connectionEpoch(), messageId);
                            if (accepted) {
                                markExecutionDispatched(messageId);
                            }
                        }
                    }
                    break;
                case "SEND_TEXT":
                    return sendTextResponse(request, payload);
                case "SESSION_REGISTER":
                    ClawBotSessionRegistration registration = ClawBotSessionWireCodec.registrationFromJson(
                            requireObject(payload, "session"));
                    requireRequestOwner(request, registration.instanceId(), registration.connectionEpoch());
                    synchronized (this) {
                        messageRouter.sweep(sessionRegistry.snapshot());
                        accepted = sessionRegistry.register(registration);
                    }
                    break;
                case "SESSION_ACTIVITY":
                    accepted = sessionRegistry.reportActivity(readString(payload, "sessionHandleId"),
                            request.instanceId(), request.connectionEpoch(), readString(payload, "generation"),
                            readBoundedString(payload, "activeTurnId", 256, true));
                    break;
                case "SESSION_HEARTBEAT":
                    requireRequestOwner(request, readString(payload, "instanceId"),
                            readLong(payload, "connectionEpoch"));
                    accepted = sessionRegistry.heartbeat(
                            readString(payload, "sessionHandleId"),
                            request.instanceId(),
                            request.connectionEpoch(),
                            readStatus(payload));
                    break;
                case "SESSION_UNREGISTER":
                    requireRequestOwner(request, readString(payload, "instanceId"),
                            readLong(payload, "connectionEpoch"));
                    synchronized (this) {
                        accepted = sessionRegistry.unregister(
                                readString(payload, "sessionHandleId"),
                                request.instanceId(),
                                request.connectionEpoch());
                        messageRouter.sweep(sessionRegistry.snapshot());
                    }
                    break;
                case "SESSION_SNAPSHOT":
                    List<ClawBotSessionRegistration> registrations = ClawBotSessionWireCodec.registrationsFromJson(
                            payload.get("sessions"));
                    synchronized (this) {
                        messageRouter.sweep(sessionRegistry.snapshot());
                        accepted = sessionRegistry.replaceSnapshot(
                                request.instanceId(), request.connectionEpoch(), registrations);
                    }
                    break;
                case "LIST_SESSIONS":
                    return response(request, "SESSION_LIST_RESULT", sessionsPayload());
                default:
                    return errorResponse(request, "CLAWBOT_IPC_REQUEST_UNSUPPORTED");
            }
            publishCurrentSessions();
            JsonObject result = new JsonObject();
            result.addProperty("accepted", accepted);
            return response(request, request.type() + "_RESULT", result);
        } catch (IOException | IllegalArgumentException error) {
            return errorResponse(request, "CLAWBOT_IPC_REQUEST_INVALID");
        }
    }

    private ClawBotIpcEnvelope controlResponse(
            ClawBotIpcEnvelope request, String operation, JsonObject payload) {
        try {
            return response(request, request.type() + "_RESULT", handleControl(operation, payload));
        } catch (IOException error) {
            return errorResponse(request, safeErrorCode(error.getMessage(), "CLAWBOT_ILINK_OPERATION_FAILED"));
        } catch (IllegalArgumentException error) {
            return errorResponse(request, "CLAWBOT_ILINK_REQUEST_INVALID");
        } catch (RuntimeException error) {
            return errorResponse(request, "CLAWBOT_ILINK_OPERATION_FAILED");
        }
    }

    private synchronized JsonObject handleControl(String operation, JsonObject payload) throws IOException {
        switch (operation) {
            case "START_PAIRING":
                return startPairing();
            case "POLL_PAIRING":
                return pollPairing(payload);
            case "CANCEL_PAIRING":
                return cancelPairing();
            case "START_TRANSPORT":
                return startTransport();
            case "UNBIND":
                return unbind();
            case "ALLOW_SENDER":
                String allowedSenderId = readBoundedString(
                        payload, "senderId", ClawBotInboundMessage.MAX_USER_ID_LENGTH, false);
                if (!senderAccessStore.isAllowed(allowedSenderId)) {
                    previewMailbox.cancelSender(allowedSenderId);
                    messageRouter.clearRoute(allowedSenderId);
                }
                senderAccessStore.allow(allowedSenderId);
                return localStatusSnapshot();
            case "REVOKE_SENDER":
                String senderId = readBoundedString(
                        payload, "senderId", ClawBotInboundMessage.MAX_USER_ID_LENGTH, false);
                senderAccessStore.revoke(senderId);
                var revocationCredentials = bindingHandoff.runtimeCredentials();
                if (revocationCredentials.isPresent()) {
                    String token = revocationCredentials.get().botToken();
                    replyRecovery.removeRecipient(senderId, token);
                    pendingDeliveries.removeRecipient(senderId, token);
                    replyCapabilities.removeRecipient(senderId, token);
                } else {
                    // Without the decryption key, discard the recovery cache so restoring credentials cannot resurrect revoked answers.
                    replyRecovery.clear();
                }
                previewMailbox.cancelSender(senderId);
                sessionRegistry.clearPendingMessagesFromSender(senderId);
                messageRouter.clearRoute(senderId);
                return localStatusSnapshot();
            case "LIST_SENDERS":
                int offset = payload.has("offset") ? readIpcNonNegativeInt(payload, "offset") : 0;
                ClawBotSenderAccessStore.SenderPage page = senderAccessStore.page(offset);
                JsonObject result = localStatusSnapshot();
                com.google.gson.JsonArray authorizedSenders = new com.google.gson.JsonArray();
                page.senderIds().forEach(authorizedSenders::add);
                result.add("authorizedSenders", authorizedSenders);
                result.addProperty("senderOffset", page.offset());
                result.addProperty("senderHasMore", page.hasMore());
                result.addProperty("senderTotalCount", page.totalCount());
                JsonObject lastUsedAt = new JsonObject();
                page.lastUsedAt().forEach(lastUsedAt::addProperty);
                result.add("senderLastUsedAt", lastUsedAt);
                return result;
            case "UPDATE_PROGRESS_SETTINGS":
                return updateProgressSettings(payload);
            case "LIST_REPLY_RECOVERY":
                return listReplyRecovery();
            case "RETRY_REPLY":
                return retryReply(payload);
            case "STATUS":
                return localStatusSnapshot();
            default:
                throw new IllegalArgumentException("Unsupported Claw Bot control operation");
        }
    }

    private JsonObject listReplyRecovery() throws IOException {
        JsonObject result = localStatusSnapshot();
        com.google.gson.JsonArray items = new com.google.gson.JsonArray();
        List<ClawBotReplyRecoveryStore.Reply> retained = List.of();
        boolean available = false;
        try {
            retained = replyRecovery.replies(System.currentTimeMillis(), deliveryToken());
            available = true;
        } catch (IOException | RuntimeException ignored) {
            // Redacted receipt diagnostics remain usable when the encrypted body store cannot be opened.
        }
        Set<String> parts = new java.util.HashSet<>();
        for (var candidate : retained) {
            int chunkCount = splitDeliveryText(candidate.text()).size();
            for (int index = 0; index < chunkCount - 1; index++) {
                parts.add(stableEventId(candidate.eventId() + ":" + index, "chunk"));
                if (!candidate.retryId().isEmpty()) {
                    parts.add(stableEventId(candidate.retryId() + ":" + index, "chunk"));
                }
            }
            if (!candidate.retryId().isEmpty()) {
                parts.add(candidate.retryId());
            }
        }
        for (var receipt : outboundReceiptStore.recent()) {
            if (!"UNKNOWN".equals(receipt.status()) && !"FAILED".equals(receipt.status())) {
                continue;
            }
            var reply = retained.stream().filter(value -> value.eventId().equals(receipt.clientId())).findFirst().orElse(null);
            // Suppress individual chunks of a retained reply; the group receipt describes the whole answer.
            if (parts.contains(receipt.clientId())) {
                continue;
            }
            JsonObject item = new JsonObject();
            item.addProperty("eventId", receipt.clientId());
            item.addProperty("status", receipt.status());
            item.addProperty("updatedAt", receipt.updatedAt());
            item.addProperty("kind", reply == null ? "OTHER" : "FINAL_REPLY");
            item.addProperty("expiresAt", reply == null ? 0 : reply.expiresAt());
            item.addProperty("reason", available ? replyRecoveryReason(reply, receipt.status()) : "STORE_UNAVAILABLE");
            item.addProperty("retryStatus", reply == null || reply.retryId().isEmpty() ? "" : recoveryRetryStatus(reply.retryId()));
            items.add(item);
            if (items.size() == 8) {
                break;
            }
        }
        result.addProperty("replyRecoveryAvailable", available);
        result.addProperty("replyRecoveryBindingRevision", bindingHandoff.status().revision());
        result.add("replyRecoveryItems", items);
        return result;
    }

    private String replyRecoveryReason(ClawBotReplyRecoveryStore.Reply reply, String status) {
        if (reply == null) {
            return "BODY_UNAVAILABLE";
        }
        if (reply.bindingRevision() != bindingHandoff.status().revision()) {
            return "BINDING_CHANGED";
        }
        if (!senderAccessStore.isAllowed(reply.recipient())) {
            return "SENDER_REVOKED";
        }
        if (System.currentTimeMillis() >= reply.expiresAt()) {
            return "EXPIRED";
        }
        if (sessionRegistry.snapshot().stream().noneMatch(reply.target()::matches)) {
            return "TARGET_CHANGED";
        }
        if (!reply.retryId().isEmpty()) {
            return "RETRY_STARTED";
        }
        if (!transportActive || ilinkProcess == null) {
            return "TRANSPORT_NOT_READY";
        }
        return "UNKNOWN".equals(status) ? "READY" : "AUTO_RETRY";
    }

    private String recoveryRetryStatus(String id) {
        String status = knownStableDeliveryStatus(id);
        if (!status.isEmpty()) {
            return status;
        }
        try {
            if (pendingDeliveries.pending(deliveryToken()).stream().anyMatch(value -> id.equals(value.groupId()))) {
                return "QUEUED";
            }
        } catch (IOException ignored) {
            // A persisted claim without a verifiable queue must never be recreated automatically.
        }
        return "UNAVAILABLE";
    }

    private JsonObject retryReply(JsonObject payload) throws IOException {
        JsonElement confirmation = payload.get("confirmed");
        if (confirmation == null || !confirmation.isJsonPrimitive() || !confirmation.getAsJsonPrimitive().isBoolean()
                || !confirmation.getAsBoolean()) {
            throw new IOException("CLAWBOT_REPLY_CONFIRMATION_REQUIRED");
        }
        long revision = readNonNegativeLong(payload, "bindingRevision");
        if (revision != bindingHandoff.status().revision()) {
            throw new IOException("CLAWBOT_REPLY_BINDING_CHANGED");
        }
        String eventId = readBoundedString(payload, "eventId", 64, false);
        ClawBotReplyRecoveryStore.Reply reply = replyRecovery.replies(System.currentTimeMillis(), deliveryToken()).stream()
                .filter(value -> value.eventId().equals(eventId)).findFirst()
                .orElseThrow(() -> new IOException("CLAWBOT_REPLY_BODY_UNAVAILABLE"));
        String reason = replyRecoveryReason(reply, knownStableDeliveryStatus(eventId));
        if (!"READY".equals(reason) && !"RETRY_STARTED".equals(reason)) {
            throw new IOException("CLAWBOT_REPLY_" + reason);
        }
        if (reply.retryId().isEmpty()) {
            String retryId = UUID.randomUUID().toString();
            List<String> chunks = splitDeliveryText(reply.text());
            java.util.ArrayList<ClawBotPendingDeliveryStore.Delivery> batch = new java.util.ArrayList<>();
            String previous = null;
            for (int index = 0; index < chunks.size(); index++) {
                String id = index == chunks.size() - 1 ? retryId : stableEventId(retryId + ":" + index, "chunk");
                batch.add(new ClawBotPendingDeliveryStore.Delivery(id, reply.recipient(), reply.context(), chunks.get(index),
                        true, previous, false, retryId, eventId));
                previous = id;
            }
            // Persist the claim first. A crash between claim and queue admission fails closed rather than risking another send.
            replyRecovery.claim(reply, retryId, deliveryToken());
            pendingDeliveries.putAll(batch, deliveryToken());
            deliveryExecutor.execute(this::retryPendingDeliveries);
        }
        return listReplyRecovery();
    }

    private JsonObject updateProgressSettings(JsonObject payload) throws IOException {
        ClawBotProgressSettings next;
        try {
            next = ClawBotProgressSettings.fromUpdatePayload(payload, progressSettings);
        } catch (IOException | IllegalArgumentException error) {
            throw new IOException("CLAWBOT_PROGRESS_SETTINGS_INVALID", error);
        }
        progressSettingsStore.save(next);
        progressSettings = next;
        return localStatusSnapshot();
    }

    private ClawBotProgressSettings loadProgressSettings() {
        try {
            return progressSettingsStore.load();
        } catch (IOException | RuntimeException error) {
            LOG.warn("[ClawBot] Progress settings unavailable; using defaults", error);
            return ClawBotProgressSettings.defaults();
        }
    }

    private JsonObject startPairing() throws IOException {
        if (!"UNBOUND".equals(bindingHandoff.status().state())) {
            throw new IOException("CLAWBOT_ALREADY_BOUND");
        }
        JsonObject result = ensureIlinkProcess().request("start_pairing", new JsonObject());
        pairingAttempt = 1;
        pairingSnapshot = sanitizePairingSnapshot(result);
        return statusSnapshot();
    }

    private JsonObject pollPairing(JsonObject payload) throws IOException {
        JsonObject params = new JsonObject();
        if (payload != null && payload.has("verifyCode") && !payload.get("verifyCode").isJsonNull()) {
            String verifyCode = readBoundedString(payload, "verifyCode", 256, false);
            params.addProperty("verifyCode", verifyCode);
        }
        JsonObject result = ensureIlinkProcess().request("poll_pairing", params);
        JsonElement credentialsElement = result.remove("credentials");
        if (credentialsElement != null) {
            bindConfirmedCredentials(credentialsElement);
            startTransport();
            pairingSnapshot = idlePairingSnapshot();
            pairingAttempt = 0;
            return statusSnapshot();
        }
        pairingSnapshot = sanitizePairingSnapshot(result);
        if (!isActivePairingState(readStringOrDefault(pairingSnapshot, "state", "IDLE"))) {
            pairingAttempt = 0;
        }
        return statusSnapshot();
    }

    private JsonObject cancelPairing() throws IOException {
        if (ilinkProcess == null || !ilinkProcess.isRunning()) {
            pairingSnapshot = idlePairingSnapshot();
            pairingAttempt = 0;
            return statusSnapshot();
        }
        JsonObject result = ilinkProcess.request("cancel_pairing", new JsonObject());
        pairingSnapshot = sanitizePairingSnapshot(result);
        pairingAttempt = 0;
        return statusSnapshot();
    }

    private JsonObject startTransport() throws IOException {
        ClawBotBindingHandoff.RuntimeCredentials credentials = bindingHandoff.runtimeCredentials()
                .orElseThrow(() -> new IOException("CLAWBOT_BINDING_REQUIRED"));
        JsonObject params = new JsonObject();
        params.addProperty("baseUrl", credentials.baseUrl());
        params.addProperty("botToken", credentials.botToken());
        params.addProperty("cursor", inboundCursor);
        ensureIlinkProcess().request("start_transport", params);
        transportActive = true;
        cancelTransportRestart();
        scheduleInboundPolling();
        return statusSnapshot();
    }

    private JsonObject unbind() throws IOException {
        previewMailbox.clear();
        clearOutboundDeliveryState();
        cancelTransportRestart();
        closeIlinkProcess();
        transportActive = false;
        sessionRegistry.clearPendingMessages();
        inboundCursor = "";
        inboundPollBackoffMillis = INBOUND_POLL_RETRY_DELAY_MILLIS;
        pairingSnapshot = idlePairingSnapshot();
        pairingAttempt = 0;
        IOException cleanupError = null;
        try {
            senderAccessStore.clear();
        } catch (IOException error) {
            cleanupError = error;
        }
        try {
            messageRouter.clear();
        } catch (IOException error) {
            if (cleanupError == null) {
                cleanupError = error;
            }
        }
        try {
            bindingHandoff.clear();
        } catch (RuntimeException error) {
            if (cleanupError == null) {
                cleanupError = new IOException("CLAWBOT_UNBIND_CREDENTIAL_CLEAR_FAILED", error);
            }
        }
        try {
            transportStateStore.clear();
        } catch (IOException error) {
            if (cleanupError == null) {
                cleanupError = error;
            }
        }
        try {
            outboundReceiptStore.clear();
            pendingDeliveries.clear();
            replyCapabilities.clear();
            replyRecovery.clear();
        } catch (IOException error) {
            if (cleanupError == null) {
                cleanupError = error;
            }
        }
        if (cleanupError != null) {
            throw cleanupError;
        }
        return statusSnapshot();
    }

    private ClawBotIpcEnvelope sendTextResponse(ClawBotIpcEnvelope request, JsonObject payload) {
        try {
            String sessionHandleId = readString(payload, "sessionHandleId");
            if (!sessionRegistry.isOwner(sessionHandleId, request.instanceId(), request.connectionEpoch())) {
                return errorResponse(request, "CLAWBOT_SESSION_NOT_OWNER");
            }
            String recipient = readBoundedString(
                    payload, "toUserId", ClawBotInboundMessage.MAX_USER_ID_LENGTH, false);
            if (!senderAccessStore.isAllowed(recipient)) {
                return errorResponse(request, "CLAWBOT_SENDER_NOT_AUTHORIZED");
            }
            JsonObject result = sendChannelText(
                    recipient,
                    readBoundedString(payload, "contextToken", ClawBotInboundMessage.MAX_CONTEXT_TOKEN_LENGTH, false),
                    readText(payload, "text", ClawBotInboundMessage.MAX_TEXT_LENGTH));
            return response(request, "SEND_TEXT_RESULT", result);
        } catch (IOException error) {
            return errorResponse(request, safeErrorCode(error.getMessage(), "CLAWBOT_ILINK_SEND_FAILED"));
        } catch (IllegalArgumentException error) {
            return errorResponse(request, "CLAWBOT_ILINK_REQUEST_INVALID");
        }
    }

    private ClawBotIpcEnvelope previewReplyResponse(ClawBotIpcEnvelope request, JsonObject payload) throws IOException {
        String handle = readString(payload, "sessionHandleId");
        String text = readText(payload, "text", 4096);
        ClawBotInboundMessage preview;
        synchronized (this) {
            messageRouter.sweep(sessionRegistry.snapshot());
            previewMailbox.sweep(messageRouter::acceptsPending);
            preview = previewMailbox.take(
                    readBoundedString(payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false),
                    handle, request.instanceId(), request.connectionEpoch());
        }
        boolean accepted = preview != null && sessionRegistry.isOwner(handle, request.instanceId(), request.connectionEpoch());
        String deliveryStatus = accepted ? "SENT" : "REJECTED";
        if (accepted) {
            try {
                sendChannelText(preview.fromUserId(), preview.contextToken(), text,
                        stableEventId(preview.messageId(), "preview"), true);
            } catch (IOException error) {
                if (!"CLAWBOT_OUTBOUND_UNKNOWN".equals(error.getMessage())) {
                    throw error;
                }
                deliveryStatus = "UNKNOWN";
            }
        }
        JsonObject result = new JsonObject();
        result.addProperty("accepted", accepted);
        result.addProperty("deliveryStatus", deliveryStatus);
        return response(request, "SESSION_PREVIEW_REPLY_RESULT", result);
    }

    private ClawBotIpcEnvelope sessionReplyResponse(ClawBotIpcEnvelope request, JsonObject payload) {
        long replyGeneration = currentOutboundGeneration();
        try {
            String sessionHandleId = readString(payload, "sessionHandleId");
            String messageId = readBoundedString(payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false);
            String text = readText(payload, "text", ClawBotInboundMessage.MAX_TEXT_LENGTH);
            String claimKey = sessionHandleId + ":" + messageId;
            String eventId = stableEventId(messageId, "terminal");
            if (!sessionRegistry.isOwner(sessionHandleId, request.instanceId(), request.connectionEpoch())) {
                return errorResponse(request, "CLAWBOT_SESSION_NOT_OWNER");
            }
            String knownStatus = knownStableDeliveryStatus(eventId);
            if (!knownStatus.isEmpty()) {
                if ("PENDING".equals(knownStatus)) {
                    return pendingResponse(request, "SESSION_REPLY_RESULT");
                }
                acknowledgeKnownInbound(request, sessionHandleId, messageId);
                return acceptedResponse(request, "SESSION_REPLY_RESULT", knownStatus);
            }
            if (!terminalRepliesInFlight.add(claimKey)) {
                return pendingResponse(request, "SESSION_REPLY_RESULT");
            }
            try {
                ClawBotInboundMessage message;
                synchronized (this) {
                    message = sessionRegistry.pollInbound(
                            sessionHandleId, request.instanceId(), request.connectionEpoch());
                    if (message == null || !message.messageId().equals(messageId)
                            || !sessionRegistry.isInboundDispatched(
                            sessionHandleId, request.instanceId(), request.connectionEpoch(), messageId)) {
                        message = recoverReplyCapability(sessionHandleId, messageId, request);
                        if (message == null) {
                            return errorResponse(request, "CLAWBOT_SESSION_MESSAGE_NOT_PENDING");
                        }
                    }
                }
                markExecutionCompleted(messageId);
                synchronized (this) {
                    ensureOutboundGeneration(replyGeneration);
                    if (message.action() == ClawBotInboundAction.MESSAGE && senderAccessStore.isAllowed(message.fromUserId())) {
                        try {
                            replyRecovery.retain(eventId, message, text, bindingHandoff.status().revision(),
                                    System.currentTimeMillis(), deliveryToken());
                        } catch (IOException | RuntimeException error) {
                            // Retention failure must not discard the original final reply; manual recovery stays unavailable.
                            LOG.warn("[ClawBot] Complete reply retention unavailable: CLAWBOT_REPLY_STORE_UNAVAILABLE");
                        }
                    }
                }
                try {
                    String predecessor = null;
                    if ("SESSION_REPLY".equals(request.type()) && message.action() == ClawBotInboundAction.MESSAGE) {
                        synchronized (this) {
                            ensureOutboundGeneration(replyGeneration);
                            predecessor = queueTaskStart(message);
                        }
                    }
                    sendReliableText(message.fromUserId(), message.contextToken(), text, eventId, true, predecessor, replyGeneration);
                } catch (IOException error) {
                    if (!"CLAWBOT_OUTBOUND_UNKNOWN".equals(error.getMessage())) {
                        throw error;
                    }
                    resolveInboundExecution(messageId);
                    synchronized (this) {
                        sessionRegistry.acknowledgeInbound(
                                sessionHandleId, request.instanceId(), request.connectionEpoch(), messageId);
                    }
                    return acceptedResponse(request, "SESSION_REPLY_RESULT", "UNKNOWN");
                }
                resolveInboundExecution(messageId);
                synchronized (this) {
                    sessionRegistry.acknowledgeInbound(
                            sessionHandleId, request.instanceId(), request.connectionEpoch(), messageId);
                }
                return acceptedResponse(request, "SESSION_REPLY_RESULT", "SENT");
            } finally {
                terminalRepliesInFlight.remove(claimKey);
            }
        } catch (IOException error) {
            return errorResponse(request, safeErrorCode(error.getMessage(), "CLAWBOT_ILINK_SEND_FAILED"));
        } catch (IllegalArgumentException error) {
            return errorResponse(request, "CLAWBOT_ILINK_REQUEST_INVALID");
        }
    }

    private ClawBotIpcEnvelope rejectPendingMessageResponse(
            ClawBotIpcEnvelope request, JsonObject payload, boolean control) {
        try {
            String handle = readString(payload, "sessionHandleId");
            String messageId = readBoundedString(
                    payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false);
            if (!sessionRegistry.isOwner(handle, request.instanceId(), request.connectionEpoch())) {
                return errorResponse(request, "CLAWBOT_SESSION_NOT_OWNER");
            }
            String notPendingCode = control
                    ? "CLAWBOT_SESSION_CONTROL_NOT_PENDING" : "CLAWBOT_SESSION_MESSAGE_NOT_PENDING";
            synchronized (this) {
                ClawBotInboundMessage pending = control
                        ? sessionRegistry.pollCommand(handle, request.instanceId(), request.connectionEpoch())
                        : sessionRegistry.pollInbound(handle, request.instanceId(), request.connectionEpoch());
                if (pending == null || !pending.messageId().equals(messageId)) {
                    return errorResponse(request, notPendingCode);
                }
                boolean alreadyDispatched = control
                        ? sessionRegistry.isCommandDispatched(
                                handle, request.instanceId(), request.connectionEpoch(), messageId)
                        : sessionRegistry.isInboundDispatched(
                                handle, request.instanceId(), request.connectionEpoch(), messageId);
                if (!alreadyDispatched) {
                    boolean accepted = control
                            ? sessionRegistry.markCommandDispatched(
                                    handle, request.instanceId(), request.connectionEpoch(), messageId)
                            : sessionRegistry.markInboundDispatched(
                                    handle, request.instanceId(), request.connectionEpoch(), messageId);
                    if (!accepted) {
                        return errorResponse(request, notPendingCode);
                    }
                    markExecutionDispatched(messageId);
                }
            }
            return control
                    ? sessionControlReplyResponse(request, payload)
                    : sessionReplyResponse(request, payload);
        } catch (IOException error) {
            return errorResponse(request, safeErrorCode(error.getMessage(), "CLAWBOT_ILINK_SEND_FAILED"));
        } catch (IllegalArgumentException error) {
            return errorResponse(request, "CLAWBOT_ILINK_REQUEST_INVALID");
        }
    }

    private synchronized boolean validatePendingCommand(
            ClawBotIpcEnvelope request, JsonObject payload) throws IOException {
        messageRouter.sweep(sessionRegistry.snapshot());
        String handle = readString(payload, "sessionHandleId");
        String messageId = readBoundedString(payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false);
        ClawBotInboundMessage command = sessionRegistry.pollCommand(
                handle, request.instanceId(), request.connectionEpoch());
        boolean accepted = command != null && command.messageId().equals(messageId)
                && messageRouter.acceptsPending(command)
                && sessionRegistry.markCommandDispatched(
                        handle, request.instanceId(), request.connectionEpoch(), messageId);
        if (accepted) {
            markExecutionDispatched(messageId);
        }
        return accepted;
    }

    private ClawBotIpcEnvelope sessionControlReplyResponse(
            ClawBotIpcEnvelope request, JsonObject payload) {
        try {
            String handle = readString(payload, "sessionHandleId");
            String messageId = readBoundedString(
                    payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false);
            String text = readText(payload, "text", ClawBotInboundMessage.MAX_TEXT_LENGTH);
            String claimKey = handle + ":" + messageId;
            String eventId = stableEventId(messageId, "control");
            if (!sessionRegistry.isOwner(handle, request.instanceId(), request.connectionEpoch())) {
                return errorResponse(request, "CLAWBOT_SESSION_NOT_OWNER");
            }
            String knownStatus = knownStableDeliveryStatus(eventId);
            if (!knownStatus.isEmpty()) {
                if ("PENDING".equals(knownStatus)) {
                    return pendingResponse(request, "SESSION_CONTROL_REPLY_RESULT");
                }
                acknowledgeKnownCommand(request, handle, messageId);
                return acceptedResponse(request, "SESSION_CONTROL_REPLY_RESULT", knownStatus);
            }
            if (!controlRepliesInFlight.add(claimKey)) {
                return pendingResponse(request, "SESSION_CONTROL_REPLY_RESULT");
            }
            try {
                ClawBotInboundMessage command;
                synchronized (this) {
                    command = sessionRegistry.pollCommand(
                            handle, request.instanceId(), request.connectionEpoch());
                    if (command == null || !command.messageId().equals(messageId)
                            || !sessionRegistry.isCommandDispatched(
                            handle, request.instanceId(), request.connectionEpoch(), messageId)) {
                        return errorResponse(request, "CLAWBOT_SESSION_CONTROL_NOT_PENDING");
                    }
                }
                markExecutionCompleted(messageId);
                try {
                    sendReliableText(command.fromUserId(), command.contextToken(), text,
                            eventId, true);
                } catch (IOException error) {
                    if (!"CLAWBOT_OUTBOUND_UNKNOWN".equals(error.getMessage())) {
                        throw error;
                    }
                    resolveInboundExecution(messageId);
                    synchronized (this) {
                        sessionRegistry.acknowledgeCommand(
                                handle, request.instanceId(), request.connectionEpoch(), messageId);
                    }
                    return acceptedResponse(request, "SESSION_CONTROL_REPLY_RESULT", "UNKNOWN");
                }
                resolveInboundExecution(messageId);
                synchronized (this) {
                    sessionRegistry.acknowledgeCommand(
                            handle, request.instanceId(), request.connectionEpoch(), messageId);
                }
                return acceptedResponse(request, "SESSION_CONTROL_REPLY_RESULT", "SENT");
            } finally {
                controlRepliesInFlight.remove(claimKey);
            }
        } catch (IOException error) {
            return errorResponse(request, safeErrorCode(error.getMessage(), "CLAWBOT_ILINK_SEND_FAILED"));
        } catch (IllegalArgumentException error) {
            return errorResponse(request, "CLAWBOT_ILINK_REQUEST_INVALID");
        }
    }

    private synchronized ClawBotIpcEnvelope sessionInteractionResponse(ClawBotIpcEnvelope request, JsonObject payload) throws IOException {
        String handle = readString(payload, "sessionHandleId");
        String messageId = readBoundedString(payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false);
        String token = readBoundedString(payload, "interactionToken", 256, true);
        ClawBotInboundMessage source = sessionRegistry.pollInbound(handle, request.instanceId(), request.connectionEpoch());
        ClawBotSessionSnapshot target = sessionRegistry.snapshot().stream()
                .filter(value -> value.sessionHandleId().equals(handle)).findFirst().orElse(null);
        if (source == null || target == null || !source.messageId().equals(messageId)
                || !sessionRegistry.isInboundDispatched(handle, request.instanceId(), request.connectionEpoch(), messageId)) {
            return errorResponse(request, "CLAWBOT_SESSION_MESSAGE_NOT_PENDING");
        }
        messageRouter.setInteraction(target, source, token);
        return acceptedResponse(request, "SESSION_INTERACTION_RESULT", "SENT");
    }

    private ClawBotIpcEnvelope sessionProgressResponse(
            ClawBotIpcEnvelope request, JsonObject payload) {
        try {
            String handle = readString(payload, "sessionHandleId");
            String messageId = readBoundedString(
                    payload, "messageId", ClawBotInboundMessage.MAX_MESSAGE_ID_LENGTH, false);
            String eventId = readBoundedString(payload, "eventId", 256, false);
            String text = readText(payload, "text", ClawBotInboundMessage.MAX_TEXT_LENGTH);
            if (!sessionRegistry.isOwner(handle, request.instanceId(), request.connectionEpoch())) {
                return errorResponse(request, "CLAWBOT_SESSION_NOT_OWNER");
            }
            String terminalStatus = knownTerminalDeliveryStatus(stableEventId(messageId, "terminal"));
            if (!terminalStatus.isEmpty()) {
                return acceptedResponse(request, "SESSION_PROGRESS_RESULT", terminalStatus);
            }
            ClawBotInboundMessage message;
            synchronized (this) {
                message = sessionRegistry.pollInbound(
                        handle, request.instanceId(), request.connectionEpoch());
                if (message == null || !message.messageId().equals(messageId)
                        || !sessionRegistry.isInboundDispatched(
                        handle, request.instanceId(), request.connectionEpoch(), messageId)) {
                    message = recoverReplyCapability(handle, messageId, request);
                    if (message == null) {
                        return errorResponse(request, "CLAWBOT_SESSION_MESSAGE_NOT_PENDING");
                    }
                }
            }
            if (deliveredProgressEvents.contains(eventId)) {
                return acceptedResponse(request, "SESSION_PROGRESS_RESULT", "SENT");
            }
            if (!progressEventsInFlight.add(eventId)) {
                return acceptedResponse(request, "SESSION_PROGRESS_RESULT", "PENDING");
            }
            try {
                if (eventId.equals(messageId + ":start")) {
                    ensureTaskStart(message);
                } else {
                    try {
                        ensureTaskStart(message);
                    } catch (IOException prerequisiteError) {
                        // An ambiguous start must not acknowledge an unattempted
                        // progress event or prevent a later interaction prompt.
                        if (!"CLAWBOT_OUTBOUND_UNKNOWN".equals(prerequisiteError.getMessage())) {
                            throw prerequisiteError;
                        }
                    }
                    boolean important = payload.has("important") && payload.get("important").getAsBoolean();
                    if (!important && progressSettings().maxNotifications() == 0) {
                        return acceptedResponse(request, "SESSION_PROGRESS_RESULT", "SUPPRESSED");
                    }
                    sendChannelText(message.fromUserId(), message.contextToken(), text,
                            stableEventId(eventId, "progress"), true, true, !important);
                }
                rememberDeliveredProgressEvent(eventId);
            } catch (IOException error) {
                if (!"CLAWBOT_OUTBOUND_UNKNOWN".equals(error.getMessage())) {
                    throw error;
                }
                rememberDeliveredProgressEvent(eventId);
                return acceptedResponse(request, "SESSION_PROGRESS_RESULT", "UNKNOWN");
            } finally {
                progressEventsInFlight.remove(eventId);
            }
            return acceptedResponse(request, "SESSION_PROGRESS_RESULT", "SENT");
        } catch (IOException error) {
            return errorResponse(request, safeErrorCode(error.getMessage(), "CLAWBOT_ILINK_SEND_FAILED"));
        } catch (IllegalArgumentException error) {
            return errorResponse(request, "CLAWBOT_ILINK_REQUEST_INVALID");
        }
    }

    private void scheduleInboundPolling() {
        if (inboundPollTask != null) {
            return;
        }
        inboundPollTask = transportExecutor.schedule(this::pollInbound, 0L, TimeUnit.MILLISECONDS);
    }

    private void rememberDeliveredProgressEvent(String eventId) {
        deliveredProgressEvents.add(eventId);
        while (deliveredProgressEvents.size() > 512) {
            deliveredProgressEvents.remove(deliveredProgressEvents.iterator().next());
        }
    }

    private String knownStableDeliveryStatus(String eventId) {
        String status = outboundEventStates.get(eventId);
        if (isStableDeliveryState(status)) {
            return status;
        }
        status = outboundReceiptStore.statusOf(eventId);
        if (isStableDeliveryState(status)) {
            outboundEventStates.put(eventId, status);
            trimOutboundEventStates();
            return status;
        }
        return "";
    }

    private String knownTerminalDeliveryStatus(String eventId) {
        String status = outboundEventStates.get(eventId);
        if (isTerminalDeliveryState(status)) {
            return status;
        }
        status = outboundReceiptStore.statusOf(eventId);
        if (isTerminalDeliveryState(status)) {
            outboundEventStates.put(eventId, status);
            trimOutboundEventStates();
            return status;
        }
        return "";
    }

    static boolean isStableDeliveryState(String status) {
        return "PENDING".equals(status) || "SENT".equals(status)
                || "UNKNOWN".equals(status);
    }

    static boolean isTerminalDeliveryState(String status) {
        return isStableDeliveryState(status) || "FAILED".equals(status);
    }

    private static boolean isLoopbackHost(String host) {
        try {
            return InetAddress.getByName(host).isLoopbackAddress();
        } catch (java.net.UnknownHostException error) {
            return false;
        }
    }

    private void acknowledgeKnownInbound(ClawBotIpcEnvelope request, String sessionHandleId, String messageId)
            throws IOException {
        resolveInboundExecution(messageId);
        synchronized (this) {
            messageRouter.clearInteraction(sessionHandleId, messageId);
            sessionRegistry.acknowledgeInbound(
                    sessionHandleId, request.instanceId(), request.connectionEpoch(), messageId);
        }
    }

    private void acknowledgeKnownCommand(ClawBotIpcEnvelope request, String sessionHandleId, String messageId)
            throws IOException {
        resolveInboundExecution(messageId);
        synchronized (this) {
            sessionRegistry.acknowledgeCommand(
                    sessionHandleId, request.instanceId(), request.connectionEpoch(), messageId);
        }
    }

    private synchronized void resolveInboundExecution(String messageId) throws IOException {
        if (transportActive) {
            replyCapabilities.remove(messageId, deliveryToken());
        }
        for (ClawBotSessionSnapshot target : sessionRegistry.snapshot()) {
            messageRouter.clearInteraction(target.sessionHandleId(), messageId);
        }
        messageRouter.resolveUncertainMessage(messageId,
                messageIds -> transportStateStore.save(
                        inboundCursor, messageIds, messageRouter.uncertainMessageIdsSnapshot()));
    }

    private boolean recordExecutionAccepted(String sessionHandleId, ClawBotInboundMessage message) throws IOException {
        return executionJournal.recordAccepted(message, sessionHandleId, System.currentTimeMillis());
    }

    private void rollbackExecutionAccepted(String messageId) throws IOException {
        executionJournal.rollbackAccepted(messageId);
    }

    private void markExecutionDispatched(String messageId) {
        try {
            executionJournal.markDispatched(messageId, System.currentTimeMillis());
        } catch (IOException error) {
            LOG.warn("[ClawBot] Execution journal dispatch update failed: " + error.getMessage());
        }
    }

    private void markExecutionCompleted(String messageId) {
        try {
            executionJournal.markCompleted(messageId, System.currentTimeMillis());
        } catch (IOException error) {
            LOG.warn("[ClawBot] Execution journal completion update failed: " + error.getMessage());
        }
    }

    private synchronized void incrementInboundDroppedCount() {
        inboundDroppedCount++;
    }

    private void pollInbound() {
        ClawBotIlinkProcess process;
        String cursor;
        synchronized (this) {
            inboundPollTask = null;
            if (disposed || state != State.LEADER || !transportActive || ilinkProcess == null) {
                return;
            }
            process = ilinkProcess;
            cursor = inboundCursor;
        }
        try {
            inboundPollCount++;
            inboundLastPollAt = System.currentTimeMillis();
            JsonObject params = new JsonObject();
            params.addProperty("cursor", cursor);
            JsonObject result = process.request("get_updates", params);
            String nextCursor = result.has("cursor") && !result.get("cursor").isJsonNull()
                    ? readBoundedString(result, "cursor", ClawBotTransportStateStore.MAX_CURSOR_LENGTH, true)
                    : cursor;
            JsonElement messages = result.get("messages");
            if (messages == null || !messages.isJsonArray()) {
                throw new IOException("CLAWBOT_ILINK_UPDATES_INVALID");
            }
            synchronized (this) {
                if (process != ilinkProcess || !transportActive || disposed || state != State.LEADER) {
                    return;
                }
                recordInboundBatch(result, messages.getAsJsonArray().size());
            }
            for (JsonElement messageElement : messages.getAsJsonArray()) {
                if (messageElement == null || !messageElement.isJsonObject()) {
                    incrementInboundDroppedCount();
                    continue;
                }
                try {
                    ClawBotInboundMessage message = ClawBotInboundMessage.fromJson(
                            messageElement.getAsJsonObject());
                    synchronized (this) {
                        if (process != ilinkProcess || !transportActive || disposed || state != State.LEADER) {
                            return;
                        }
                        if (senderAccessStore.isAllowed(message.fromUserId())
                                && !messageRouter.seenMessageIdsSnapshot().contains(message.messageId())) {
                            outboundProtection.renewConversation(
                                    stableEventId(message.fromUserId() + ":" + message.contextToken(), "conversation"),
                                    stableEventId(message.messageId(), "inbound"));
                        }
                        // Router callbacks acquire this monitor, so always enter gateway before router.
                        messageRouter.handle(
                                message,
                                sessionRegistry.snapshot(),
                                channelReplySender(),
                                sessionRegistry::enqueueInbound,
                                sessionRegistry::enqueueCommand,
                                messageIds -> transportStateStore.save(
                                        cursor, messageIds, messageRouter.uncertainMessageIdsSnapshot()),
                                new ClawBotMessageRouter.ExecutionRecorder() {
                                    @Override
                                    public boolean recordAccepted(
                                            String sessionHandleId, ClawBotInboundMessage acceptedMessage)
                                            throws IOException {
                                        return recordExecutionAccepted(sessionHandleId, acceptedMessage);
                                    }

                                    @Override
                                    public void rollbackAccepted(String messageId) throws IOException {
                                        rollbackExecutionAccepted(messageId);
                                    }
                                });
                    }
                } catch (IllegalArgumentException error) {
                    incrementInboundDroppedCount();
                    LOG.warn("[ClawBot] Dropped malformed inbound message: " + error.getMessage());
                }
            }
            synchronized (this) {
                if (process != ilinkProcess || !transportActive || disposed || state != State.LEADER) {
                    return;
                }
                transportStateStore.save(nextCursor, messageRouter.seenMessageIdsSnapshot(),
                        messageRouter.uncertainMessageIdsSnapshot());
                inboundCursor = nextCursor;
                inboundLastError = "";
                inboundLastSuccessAt = System.currentTimeMillis();
                inboundPollBackoffMillis = INBOUND_POLL_RETRY_DELAY_MILLIS;
            }
        } catch (IOException error) {
            inboundLastError = describeInboundError(error);
            LOG.warn("[ClawBot] Inbound polling failed: " + inboundLastError);
            synchronized (this) {
                if (process == ilinkProcess && "ILINK_AUTH_REJECTED".equals(error.getMessage())) {
                    closeIlinkProcess();
                    transportActive = false;
                    bindingHandoff.clear();
                    try {
                        messageRouter.clear();
                    } catch (IOException ignored) {
                    }
                    try {
                        senderAccessStore.clear();
                    } catch (IOException ignored) {
                    }
                    sessionRegistry.clearPendingMessages();
                    inboundCursor = "";
                    inboundPollBackoffMillis = INBOUND_POLL_RETRY_DELAY_MILLIS;
                    try {
                        transportStateStore.clear();
                    } catch (IOException ignored) {
                    }
                } else if (process == ilinkProcess && transportActive) {
                    inboundPollBackoffMillis = Math.min(
                            INBOUND_POLL_MAX_BACKOFF_MILLIS, inboundPollBackoffMillis * 2L);
                    closeIlinkProcess();
                    transportActive = false;
                    scheduleTransportRestart();
                }
            }
        } finally {
            synchronized (this) {
                if (!disposed && state == State.LEADER && transportActive && ilinkProcess == process) {
                    inboundPollTask = transportExecutor.schedule(
                            this::pollInbound, inboundPollBackoffMillis, TimeUnit.MILLISECONDS);
                }
            }
        }
    }

    synchronized void recordInboundBatch(JsonObject result, int acceptedCount) throws IOException {
        int receivedCount = acceptedCount;
        int droppedCount = 0;
        if (result.has("receivedCount") || result.has("droppedCount")) {
            try {
                receivedCount = result.get("receivedCount").getAsBigDecimal().intValueExact();
                droppedCount = result.get("droppedCount").getAsBigDecimal().intValueExact();
            } catch (RuntimeException error) {
                throw new IOException("CLAWBOT_ILINK_UPDATES_INVALID", error);
            }
        }
        if (acceptedCount < 0 || receivedCount < acceptedCount || droppedCount < 0
                || receivedCount - acceptedCount != droppedCount) {
            throw new IOException("CLAWBOT_ILINK_UPDATES_INVALID");
        }
        inboundMessageCount += receivedCount;
        inboundDroppedCount += droppedCount;
    }

    private static String describeInboundError(IOException error) {
        String code = error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage();
        if (error.getCause() instanceof ClawBotIlinkProcess.IlinkDaemonException daemonError
                && daemonError.detail() != null && !daemonError.detail().isBlank()) {
            return code + " (" + daemonError.detail() + ")";
        }
        return code;
    }

    private JsonObject sendChannelText(String toUserId, String contextToken, String text) throws IOException {
        return sendChannelText(toUserId, contextToken, text, UUID.randomUUID().toString(), false);
    }

    private ClawBotMessageRouter.ReplySender channelReplySender() {
        return new ClawBotMessageRouter.ReplySender() {
            @Override
            public void send(String toUserId, String contextToken, String text) throws IOException {
                enqueueChannelReply(toUserId, contextToken, text);
            }

            @Override
            public void send(ClawBotInboundMessage message, String text) throws IOException {
                enqueueChannelReply(message.fromUserId(), message.contextToken(), text,
                        stableEventId(message.messageId(), "command-reply"), true);
            }

            @Override
            public void sendUncertain(ClawBotInboundMessage message, String text) throws IOException {
                enqueueChannelReply(message.fromUserId(), message.contextToken(), text,
                        stableEventId(message.messageId(), "uncertain-warning"), true);
            }
        };
    }

    private void enqueueChannelReply(String toUserId, String contextToken, String text) throws IOException {
        enqueueChannelReply(toUserId, contextToken, text, UUID.randomUUID().toString(), false);
    }

    private void enqueueChannelReply(
            String toUserId, String contextToken, String text, String clientId, boolean stableEvent)
            throws IOException {
        long queuedGeneration = currentOutboundGeneration();
        try {
            replyExecutor.execute(() -> {
                try {
                    sendReliableText(toUserId, contextToken, text, clientId, false, null, queuedGeneration);
                    outboundLastError = "";
                } catch (IOException | RuntimeException error) {
                    outboundLastError = describeOutboundError(error, "CLAWBOT_ILINK_SEND_FAILED");
                    LOG.warn("[ClawBot] Command reply delivery failed: " + outboundLastError);
                }
            });
        } catch (RejectedExecutionException error) {
            outboundLastError = "CLAWBOT_REPLY_EXECUTOR_CLOSED";
            throw new IOException(outboundLastError, error);
        }
    }

    static void runRejectedReplyOnCaller(Runnable task, ThreadPoolExecutor executor) {
        if (executor.isShutdown()) {
            throw new RejectedExecutionException("Claw Bot reply executor is closed");
        }
        task.run();
    }

    private String deliveryToken() throws IOException {
        return bindingHandoff.runtimeCredentials().orElseThrow(
                () -> new IOException("CLAWBOT_ILINK_TRANSPORT_NOT_READY")).botToken();
    }

    private ClawBotInboundMessage recoverReplyCapability(String handle, String messageId, ClawBotIpcEnvelope request) throws IOException {
        for (var entry : replyCapabilities.pending(deliveryToken())) {
            if (!entry.id().equals(messageId) || !senderAccessStore.isAllowed(entry.recipient())) {
                continue;
            }
            ClawBotInboundMessage message = ClawBotInboundMessage.fromJson(
                    com.google.gson.JsonParser.parseString(entry.text()).getAsJsonObject());
            if (message.target() != null && message.target().handle().equals(handle)
                    && message.target().instanceId().equals(request.instanceId())
                    && message.target().connectionEpoch() == request.connectionEpoch()
                    && sessionRegistry.snapshot().stream().anyMatch(message.target()::matches)) {
                return message;
            }
        }
        return null;
    }

    private synchronized String queueTaskStart(ClawBotInboundMessage message) throws IOException {
        if (!senderAccessStore.isAllowed(message.fromUserId())) {
            throw new IOException("CLAWBOT_SENDER_NOT_AUTHORIZED");
        }
        if (message.target() != null) {
            JsonObject capability = message.toJson();
            capability.addProperty("text", "Reply capability");
            replyCapabilities.put(new ClawBotPendingDeliveryStore.Delivery(message.messageId(), message.fromUserId(),
                    message.contextToken(), capability.toString(), true, null), deliveryToken());
        }
        String eventId = stableEventId(message.messageId() + ":start", "progress");
        if (!"SENT".equals(knownStableDeliveryStatus(eventId))) {
            pendingDeliveries.put(new ClawBotPendingDeliveryStore.Delivery(eventId, message.fromUserId(),
                    message.contextToken(), "任务已开始处理，IDE 正在生成响应。", true, null), deliveryToken());
        }
        return eventId;
    }

    private void ensureTaskStart(ClawBotInboundMessage message) throws IOException {
        String eventId;
        long generation;
        synchronized (this) {
            generation = outboundGeneration;
            eventId = queueTaskStart(message);
        }
        sendReliableText(message.fromUserId(), message.contextToken(), "任务已开始处理，IDE 正在生成响应。", eventId, true, null, generation);
    }

    private JsonObject sendReliableText(String recipient, String context, String text, String id, boolean authorized) throws IOException {
        return sendReliableText(recipient, context, text, id, authorized, null);
    }

    private JsonObject sendReliableText(String recipient, String context, String text, String id,
            boolean authorized, String predecessor) throws IOException {
        return sendReliableText(recipient, context, text, id, authorized, predecessor, currentOutboundGeneration());
    }

    private synchronized long currentOutboundGeneration() {
        return outboundGeneration;
    }

    private JsonObject sendReliableText(String recipient, String context, String text, String id,
            boolean authorized, String predecessor, long deliveryGeneration) throws IOException {
        synchronized (this) {
            ensureOutboundGeneration(deliveryGeneration);
        }
        if ("SENT".equals(knownStableDeliveryStatus(id))) {
            return new JsonObject();
        }
        List<String> chunks = splitDeliveryText(text);
        java.util.ArrayList<ClawBotPendingDeliveryStore.Delivery> deliveries = new java.util.ArrayList<>();
        String previous = predecessor;
        for (int index = 0; index < chunks.size(); index++) {
            String chunkId = index == chunks.size() - 1 ? id : stableEventId(id + ":" + index, "chunk");
            if (!"SENT".equals(knownStableDeliveryStatus(chunkId))) {
                deliveries.add(new ClawBotPendingDeliveryStore.Delivery(
                        chunkId, recipient, context, chunks.get(index), authorized, previous, false, id));
            }
            previous = chunkId;
        }
        synchronized (this) {
            ensureOutboundGeneration(deliveryGeneration);
            deliveries = new java.util.ArrayList<>(pendingDeliveries.putAll(deliveries, deliveryToken()));
        }
        JsonObject result = new JsonObject();
        for (ClawBotPendingDeliveryStore.Delivery delivery : deliveries) {
            if ("SENT".equals(knownStableDeliveryStatus(delivery.id()))) {
                continue;
            }
            result = deliverPending(delivery, deliveryGeneration);
            if (!delivery.id().equals(id)) {
                // Long replies remain in the durable queue; never hold local IPC across multiple wire timeouts.
                throw new IOException("CLAWBOT_SEND_DEFERRED");
            }
        }
        return result;
    }

    static List<String> splitDeliveryText(String text) {
        java.util.ArrayList<String> chunks = new java.util.ArrayList<>();
        for (int start = 0; start < text.length();) {
            int end = Math.min(text.length(), start + 4000);
            if (end < text.length() && Character.isHighSurrogate(text.charAt(end - 1))) {
                end--;
            }
            chunks.add(text.substring(start, end));
            start = end;
        }
        return chunks;
    }

    private JsonObject deliverPending(ClawBotPendingDeliveryStore.Delivery delivery, long deliveryGeneration) throws IOException {
        synchronized (this) {
            ensureOutboundGeneration(deliveryGeneration);
            var current = pendingDeliveries.pending(deliveryToken()).stream()
                    .filter(value -> value.id().equals(delivery.id())).findFirst().orElse(null);
            if (current == null) {
                if ("SENT".equals(knownStableDeliveryStatus(delivery.id()))) {
                    return new JsonObject();
                }
                throw new IOException("CLAWBOT_OUTBOUND_CANCELLED");
            }
            if (current.unknown()) {
                archiveUnknownDelivery(current);
                throw new IOException("CLAWBOT_OUTBOUND_UNKNOWN");
            }
            validateRecoveryDelivery(current);
        }
        if (delivery.unknown()) {
            throw new IOException("CLAWBOT_OUTBOUND_UNKNOWN");
        }
        if ("SENT".equals(knownStableDeliveryStatus(delivery.id()))) {
            synchronized (this) {
                ensureOutboundGeneration(deliveryGeneration);
                pendingDeliveries.remove(delivery.id(), deliveryToken());
                releaseCompletedReplyCapability(delivery.id());
            }
            return new JsonObject();
        }
        if (!deliveriesInFlight.add(delivery.id())) {
            throw new IOException("CLAWBOT_DELIVERY_PENDING");
        }
        try {
            if (System.currentTimeMillis() < deliveryRetryAt.getOrDefault(delivery.id(), 0L)) {
                throw new IOException("CLAWBOT_SEND_DEFERRED");
            }
            if (delivery.predecessor() != null && !"SENT".equals(knownStableDeliveryStatus(delivery.predecessor()))
                    && !"UNKNOWN".equals(knownStableDeliveryStatus(delivery.predecessor()))) {
                ClawBotPendingDeliveryStore.Delivery previous = pendingDeliveries.pending(deliveryToken()).stream()
                        .filter(value -> value.id().equals(delivery.predecessor())).findFirst().orElse(null);
                if (previous == null) {
                    throw new IOException("CLAWBOT_SEND_DEFERRED");
                }
                if (!previous.unknown()) {
                    deliverPending(previous, deliveryGeneration);
                    throw new IOException("CLAWBOT_SEND_DEFERRED");
                }
            }
            JsonObject result = sendChannelText(delivery.recipient(), delivery.context(), delivery.text(),
                    delivery.id(), true, delivery.requireAuthorization(), !delivery.requireAuthorization(), deliveryGeneration);
            synchronized (this) {
                ensureOutboundGeneration(deliveryGeneration);
                pendingDeliveries.remove(delivery.id(), deliveryToken());
                releaseCompletedReplyCapability(delivery.id());
                deliveryRetryAt.remove(delivery.id());
            }
            return result;
        } catch (IOException error) {
            synchronized (this) {
                ensureOutboundGeneration(deliveryGeneration);
                if ("UNKNOWN".equals(knownStableDeliveryStatus(delivery.id()))) {
                    archiveUnknownDelivery(delivery);
                }
            }
            // Rejected requests are safe to retry, but never hammer an expired context.
            if (!"CLAWBOT_SEND_DEFERRED".equals(error.getMessage())
                    && !"CLAWBOT_DELIVERY_PENDING".equals(error.getMessage())) {
                long retryDelay = "ILINK_SEND_REJECTED".equals(error.getMessage()) ? 300_000L : 5_000L;
                deliveryRetryAt.merge(delivery.id(), System.currentTimeMillis() + retryDelay, Math::max);
            }
            throw error;
        } finally {
            deliveriesInFlight.remove(delivery.id());
        }
    }

    private void validateRecoveryDelivery(ClawBotPendingDeliveryStore.Delivery delivery) throws IOException {
        if (delivery.recoverySource() == null) {
            return;
        }
        var reply = replyRecovery.replies(System.currentTimeMillis(), deliveryToken()).stream()
                .filter(value -> value.eventId().equals(delivery.recoverySource())).findFirst().orElse(null);
        String reason = replyRecoveryReason(reply, "UNKNOWN");
        if (reply == null || !"RETRY_STARTED".equals(reason) || !reply.retryId().equals(delivery.groupId())
                || !reply.recipient().equals(delivery.recipient()) || !reply.context().equals(delivery.context())) {
            for (var queued : pendingDeliveries.pending(deliveryToken())) {
                if (Objects.equals(queued.groupId(), delivery.groupId())) {
                    pendingDeliveries.remove(queued.id(), deliveryToken());
                }
            }
            throw new IOException("CLAWBOT_REPLY_" + reason);
        }
    }

    private void releaseCompletedReplyCapability(String eventId) throws IOException {
        for (var capability : replyCapabilities.pending(deliveryToken())) {
            if (stableEventId(capability.id(), "terminal").equals(eventId)) {
                replyCapabilities.remove(capability.id(), deliveryToken());
            }
        }
    }

    private void archiveUnknownDelivery(ClawBotPendingDeliveryStore.Delivery delivery) throws IOException {
        pendingDeliveries.markUnknown(delivery.id(), deliveryToken());
        // Stop the remaining parts after an ambiguous chunk. The final event
        // must describe the entire reply, not just the last successful chunk.
        if (delivery.groupId() != null && !"UNKNOWN".equals(knownStableDeliveryStatus(delivery.groupId()))) {
            long now = System.currentTimeMillis();
            outboundReceiptStore.begin(delivery.groupId(), now);
            outboundReceiptStore.complete(delivery.groupId(), "UNKNOWN", "CLAWBOT_OUTBOUND_UNKNOWN", now);
            outboundEventStates.put(delivery.groupId(), "UNKNOWN");
            releaseCompletedReplyCapability(delivery.groupId());
        }
    }

    private void retryPendingDeliveries() {
        long deliveryGeneration;
        synchronized (this) {
            deliveryGeneration = outboundGeneration;
            if (disposed || state != State.LEADER || !transportActive) {
                return;
            }
        }
        try {
            List<ClawBotPendingDeliveryStore.Delivery> queued = pendingDeliveries.pending(deliveryToken()).stream()
                    .sorted(java.util.Comparator.comparingInt(value -> value.predecessor() != null ? 0
                            : value.requireAuthorization() ? 1 : 2)).toList();
            for (ClawBotPendingDeliveryStore.Delivery delivery : queued) {
                // An ambiguous wire result is retained for diagnosis, never silently resent.
                if (delivery.unknown() || "UNKNOWN".equals(knownStableDeliveryStatus(delivery.id()))) {
                    synchronized (this) {
                        ensureOutboundGeneration(deliveryGeneration);
                        archiveUnknownDelivery(delivery);
                    }
                    continue;
                }
                if (outboundProtection.nextAllowedAt(System.currentTimeMillis()) > System.currentTimeMillis()) {
                    break;
                }
                try {
                    deliverPending(delivery, deliveryGeneration);
                } catch (IOException error) {
                    if (!"CLAWBOT_SEND_DEFERRED".equals(error.getMessage()) && !"CLAWBOT_DELIVERY_PENDING".equals(error.getMessage())) {
                        outboundLastError = describeOutboundError(error, "CLAWBOT_ILINK_SEND_FAILED");
                    }
                }
            }
        } catch (IOException | RuntimeException error) {
            outboundLastError = describeOutboundError(error, "CLAWBOT_DELIVERY_STORE_UNAVAILABLE");
        }
    }

    private JsonObject sendChannelText(
            String toUserId, String contextToken, String text, String clientId, boolean stableEvent) throws IOException {
        return sendChannelText(toUserId, contextToken, text, clientId, stableEvent, stableEvent);
    }

    private JsonObject sendChannelText(
            String toUserId, String contextToken, String text, String clientId,
            boolean stableEvent, boolean requireAuthorizedSender) throws IOException {
        return sendChannelText(toUserId, contextToken, text, clientId, stableEvent, requireAuthorizedSender, false);
    }

    private JsonObject sendChannelText(
            String toUserId, String contextToken, String text, String clientId,
            boolean stableEvent, boolean requireAuthorizedSender, boolean ordinary) throws IOException {
        return sendChannelText(toUserId, contextToken, text, clientId, stableEvent,
                requireAuthorizedSender, ordinary, null);
    }

    private JsonObject sendChannelText(
            String toUserId, String contextToken, String text, String clientId,
            boolean stableEvent, boolean requireAuthorizedSender, boolean ordinary,
            Long expectedGeneration) throws IOException {
        if (toUserId == null || toUserId.isBlank() || toUserId.length() > ClawBotInboundMessage.MAX_USER_ID_LENGTH
                || contextToken == null || contextToken.isBlank()
                || contextToken.length() > ClawBotInboundMessage.MAX_CONTEXT_TOKEN_LENGTH
                || text == null || text.isEmpty() || text.length() > ClawBotInboundMessage.MAX_TEXT_LENGTH) {
            throw new IOException("CLAWBOT_ILINK_SEND_REQUEST_INVALID");
        }
        if (stableEvent && requireAuthorizedSender && !senderAccessStore.isAllowed(toUserId)) {
            throw new IOException("CLAWBOT_SENDER_NOT_AUTHORIZED");
        }
        ClawBotIlinkProcess process;
        long generation;
        synchronized (this) {
            if (state != State.LEADER || !transportActive || ilinkProcess == null) {
                throw new IOException("CLAWBOT_ILINK_TRANSPORT_NOT_READY");
            }
            if (expectedGeneration != null) {
                ensureOutboundGeneration(expectedGeneration);
            }
            process = ilinkProcess;
            generation = outboundGeneration;
        }
        try {
            UUID.fromString(clientId);
        } catch (IllegalArgumentException error) {
            throw new IOException("CLAWBOT_ILINK_SEND_REQUEST_INVALID", error);
        }
        if (stableEvent) {
            ensureOutboundGeneration(generation);
            String knownState = outboundEventStates.get(clientId);
            if ("SENT".equals(knownState)) {
                return new JsonObject();
            }
            if ("UNKNOWN".equals(knownState)) {
                throw new IOException("CLAWBOT_OUTBOUND_UNKNOWN");
            }
            if ("PENDING".equals(knownState)) {
                throw new IOException("CLAWBOT_DELIVERY_PENDING");
            }
            if ("FAILED".equals(knownState)) {
                outboundEventStates.put(clientId, "PENDING");
            } else {
                outboundEventStates.putIfAbsent(clientId, "PENDING");
            }
            String persistedState = outboundReceiptStore.statusOf(clientId);
            if ("SENT".equals(persistedState)) {
                outboundEventStates.put(clientId, "SENT");
                return new JsonObject();
            }
            if ("UNKNOWN".equals(persistedState)) {
                outboundEventStates.put(clientId, "UNKNOWN");
                throw new IOException("CLAWBOT_OUTBOUND_UNKNOWN");
            }
        }
        JsonObject params = new JsonObject();
        params.addProperty("toUserId", toUserId);
        params.addProperty("clientId", clientId);
        params.addProperty("text", text);
        params.addProperty("contextToken", contextToken);
        boolean requestStarted = false;
        try {
            synchronized (this) {
                ensureOutboundGeneration(generation);
                if (stableEvent && requireAuthorizedSender && !senderAccessStore.isAllowed(toUserId)) {
                    throw new IOException("CLAWBOT_SENDER_NOT_AUTHORIZED");
                }
                for (var queued : pendingDeliveries.pending(deliveryToken())) {
                    if (queued.id().equals(clientId)) {
                        validateRecoveryDelivery(queued);
                        break;
                    }
                }
                if (ordinary && pendingDeliveries.pending(deliveryToken()).stream().anyMatch(
                        value -> value.requireAuthorization() && !isStableDeliveryState(outboundReceiptStore.statusOf(value.id())))) {
                    throw new IOException("CLAWBOT_SEND_DEFERRED");
                }
                if (!outboundProtection.acquire(System.currentTimeMillis(), ordinary,
                        stableEventId(toUserId + ":" + contextToken, "conversation"))) {
                    throw new IOException("CLAWBOT_SEND_DEFERRED");
                }
                outboundReceiptStore.begin(clientId, System.currentTimeMillis());
                requestStarted = true;
            }
            JsonObject result = process.request("send_text", params);
            synchronized (this) {
                ensureOutboundGeneration(generation);
                try {
                    outboundReceiptStore.complete(clientId, "SENT", null, System.currentTimeMillis());
                } catch (IOException error) {
                    LOG.warn("[ClawBot] Outbound receipt persistence failed: CLAWBOT_OUTBOX_STORE_UNAVAILABLE");
                }
                outboundLastSuccessAt = System.currentTimeMillis();
                outboundLastError = "";
                if (stableEvent) {
                    outboundEventStates.put(clientId, "SENT");
                    trimOutboundEventStates();
                }
            }
            return result;
        } catch (IOException | RuntimeException error) {
            boolean generationChanged;
            synchronized (this) {
                generationChanged = generation != outboundGeneration;
                if (generationChanged && stableEvent) {
                    outboundEventStates.remove(clientId, "PENDING");
                }
            }
            if (generationChanged) {
                throw new IOException("CLAWBOT_OUTBOUND_CANCELLED", error);
            }
            if (!requestStarted) {
                if (stableEvent) {
                    outboundEventStates.remove(clientId, "PENDING");
                }
                if (error instanceof IOException ioError) {
                    throw ioError;
                }
                throw new IOException("CLAWBOT_ILINK_SEND_FAILED", error);
            }
            String errorCode = safeErrorCode(error.getMessage(), "CLAWBOT_ILINK_SEND_FAILED");
            outboundLastError = describeOutboundError(error, errorCode);
            LOG.warn("[ClawBot] Outbound delivery failed: " + outboundLastError);
            String outcome = ("ILINK_SEND_REJECTED".equals(errorCode) || "ILINK_SEND_RATE_LIMITED".equals(errorCode))
                    ? "FAILED" : "UNKNOWN";
            if ("ILINK_SEND_RATE_LIMITED".equals(errorCode)) {
                try {
                    outboundProtection.coolDown(System.currentTimeMillis(), retryAfterMillis(error));
                } catch (IOException persistenceError) {
                    LOG.warn("[ClawBot] Send cooldown persistence failed", persistenceError);
                }
            }
            try {
                outboundReceiptStore.complete(clientId, outcome, errorCode, System.currentTimeMillis());
            } catch (IOException receiptError) {
                LOG.warn("[ClawBot] Outbound receipt persistence failed: CLAWBOT_OUTBOX_STORE_UNAVAILABLE");
            }
            if (stableEvent && "UNKNOWN".equals(outcome)) {
                outboundEventStates.put(clientId, "UNKNOWN");
            } else if (stableEvent) {
                outboundEventStates.put(clientId, "FAILED");
                trimOutboundEventStates();
            }
            if (error instanceof IOException ioError) {
                throw ioError;
            }
            throw new IOException("CLAWBOT_OUTBOUND_UNKNOWN", error);
        }
    }

    private void trimOutboundEventStates() {
        while (outboundEventStates.size() > 2048) {
            String firstKey = outboundEventStates.keySet().iterator().next();
            outboundEventStates.remove(firstKey);
        }
    }

    private static String stableEventId(String value, String kind) {
        return UUID.nameUUIDFromBytes((kind + ":" + value)
                .getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();
    }

    private synchronized void resumeBoundTransport() {
        if (!"BOUND".equals(bindingHandoff.status().state()) || transportActive || disposed) {
            return;
        }
        transportExecutor.execute(() -> {
            try {
                synchronized (ClawBotGatewayRuntimeService.this) {
                    if (disposed || state != State.LEADER || transportActive) {
                        return;
                    }
                    startTransport();
                }
            } catch (IOException | RuntimeException ignored) {
                // A later explicit refresh/start operation can retry without exposing credentials.
            }
        });
    }

    private synchronized void scheduleTransportRestart() {
        if (disposed || state != State.LEADER || !bindingHandoff.status().state().equals("BOUND")) {
            return;
        }
        if (transportRestartTask != null && !transportRestartTask.isDone()) {
            return;
        }
        long delayMillis = inboundPollBackoffMillis;
        transportRestartTask = transportExecutor.schedule(() -> {
            synchronized (ClawBotGatewayRuntimeService.this) {
                transportRestartTask = null;
                if (disposed || state != State.LEADER || transportActive) {
                    return;
                }
                try {
                    startTransport();
                } catch (IOException | RuntimeException ignored) {
                    inboundPollBackoffMillis = Math.min(
                            INBOUND_POLL_MAX_BACKOFF_MILLIS, inboundPollBackoffMillis * 2L);
                    scheduleTransportRestart();
                }
            }
        }, delayMillis, TimeUnit.MILLISECONDS);
    }

    private synchronized void recoverTransportIfProcessStopped() {
        if (disposed || state != State.LEADER || !transportActive
                || (ilinkProcess != null && ilinkProcess.isRunning())) {
            return;
        }
        closeIlinkProcess();
        transportActive = false;
        inboundLastError = "CLAWBOT_ILINK_PROCESS_UNAVAILABLE";
        scheduleTransportRestart();
    }

    private synchronized void cancelTransportRestart() {
        if (transportRestartTask != null) {
            transportRestartTask.cancel(false);
            transportRestartTask = null;
        }
    }

    private void bindConfirmedCredentials(JsonElement credentialsElement) throws IOException {
        if (credentialsElement == null || !credentialsElement.isJsonObject()) {
            throw new IOException("CLAWBOT_ILINK_CREDENTIALS_INVALID");
        }
        JsonObject credentials = credentialsElement.getAsJsonObject();
        String botId = readBoundedString(credentials, "botId", 512, false);
        String baseUrl = readBoundedString(credentials, "baseUrl", 2048, false);
        String botToken = readBoundedString(credentials, "botToken", 16 * 1024, false);
        String userId = credentials.has("userId") && !credentials.get("userId").isJsonNull()
                ? readBoundedString(credentials, "userId", 512, false) : null;
        senderAccessStore.clear();
        sessionRegistry.clearPendingMessages();
        transportStateStore.clear();
        executionJournal.clear();
        clearOutboundDeliveryState();
        outboundReceiptStore.clear();
        pendingDeliveries.clear();
            replyCapabilities.clear();
        messageRouter.clear();
        inboundCursor = "";
        inboundPollBackoffMillis = INBOUND_POLL_RETRY_DELAY_MILLIS;
        bindingHandoff.accept(botId, baseUrl, userId, botToken);
    }

    private synchronized void clearOutboundDeliveryState() {
        outboundGeneration++;
        outboundEventStates.clear();
        deliveryRetryAt.clear();
        deliveredProgressEvents.clear();
        progressEventsInFlight.clear();
        terminalRepliesInFlight.clear();
        controlRepliesInFlight.clear();
    }

    private synchronized void ensureOutboundGeneration(long generation) throws IOException {
        if (generation != outboundGeneration) {
            throw new IOException("CLAWBOT_OUTBOUND_CANCELLED");
        }
    }

    private ClawBotIlinkProcess ensureIlinkProcess() throws IOException {
        if (ilinkProcess != null && ilinkProcess.isRunning()) {
            return ilinkProcess;
        }
        closeIlinkProcess();
        ClawBotIlinkProcess candidate = new ClawBotIlinkProcess();
        try {
            candidate.start();
        } catch (IOException | RuntimeException error) {
            candidate.close();
            throw error;
        }
        ilinkProcess = candidate;
        return candidate;
    }

    private void closeIlinkProcess() {
        if (inboundPollTask != null) {
            inboundPollTask.cancel(false);
            inboundPollTask = null;
        }
        ClawBotIlinkProcess current = ilinkProcess;
        ilinkProcess = null;
        if (current != null) {
            current.close();
        }
    }

    private static JsonObject sanitizePairingSnapshot(JsonObject result) throws IOException {
        if (result == null) {
            throw new IOException("CLAWBOT_ILINK_PAIRING_RESPONSE_INVALID");
        }
        JsonObject snapshot = new JsonObject();
        String state = readBoundedString(result, "state", 64, false);
        snapshot.addProperty("state", state);
        snapshot.addProperty("refreshCount", readNonNegativeInt(result, "refreshCount"));
        if (result.has("expiresAt") && !result.get("expiresAt").isJsonNull()) {
            snapshot.addProperty("expiresAt", readNonNegativeLong(result, "expiresAt"));
        } else {
            snapshot.add("expiresAt", com.google.gson.JsonNull.INSTANCE);
        }
        if (result.has("qrCodeImageContent") && !result.get("qrCodeImageContent").isJsonNull()) {
            String qrCode = readBoundedString(result, "qrCodeImageContent", MAX_PAIRING_QR_LENGTH, false);
            if (!qrCode.startsWith("data:image/")) {
                throw new IOException("CLAWBOT_ILINK_PAIRING_QR_INVALID");
            }
            snapshot.addProperty("qrCodeImageContent", qrCode);
        }
        return snapshot;
    }

    private static JsonObject idlePairingSnapshot() {
        JsonObject snapshot = new JsonObject();
        snapshot.addProperty("state", "IDLE");
        snapshot.addProperty("refreshCount", 0);
        snapshot.add("expiresAt", com.google.gson.JsonNull.INSTANCE);
        return snapshot;
    }

    private static boolean isActivePairingState(String state) {
        return "WAITING_SCAN".equals(state) || "SCANNED".equals(state)
                || "NEED_VERIFY_CODE".equals(state) || "REDIRECTING".equals(state);
    }

    private static String requireControlOperation(String operation) {
        if (operation == null || operation.isBlank() || operation.length() > 64
                || operation.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid Claw Bot control operation");
        }
        return operation.trim().toUpperCase(java.util.Locale.ROOT);
    }

    private static ClawBotCredentialStore.SecretBackend inMemorySecretBackend() {
        java.util.Map<String, String> values = new java.util.HashMap<>();
        return new ClawBotCredentialStore.SecretBackend() {
            @Override
            public String read(String key) {
                return values.get(key);
            }

            @Override
            public void write(String key, String value) {
                values.put(key, value);
            }

            @Override
            public void clear(String key) {
                values.remove(key);
            }
        };
    }

    private static String readBoundedString(JsonObject object, String name, int maxLength, boolean allowEmpty)
            throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IOException("CLAWBOT_ILINK_FIELD_INVALID_" + name.toUpperCase(java.util.Locale.ROOT));
        }
        String text = value.getAsString();
        if (text.length() > maxLength || (!allowEmpty && text.isEmpty())
                || text.chars().anyMatch(Character::isISOControl)) {
            throw new IOException("CLAWBOT_ILINK_FIELD_INVALID_" + name.toUpperCase(java.util.Locale.ROOT));
        }
        return text;
    }

    private static String readText(JsonObject object, String name, int maxLength) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
            throw new IOException("CLAWBOT_ILINK_FIELD_INVALID_" + name.toUpperCase(java.util.Locale.ROOT));
        }
        String text = value.getAsString();
        if (text.isEmpty() || text.length() > maxLength || text.chars().anyMatch(character -> character < 0x20
                && character != '\t' && character != '\n' && character != '\r' || character == 0x7F)) {
            throw new IOException("CLAWBOT_ILINK_FIELD_INVALID_" + name.toUpperCase(java.util.Locale.ROOT));
        }
        return text;
    }

    private static int readIpcNonNegativeInt(JsonObject object, String name) throws IOException {
        try {
            int value = object.get(name).getAsInt();
            if (value < 0) {
                throw new NumberFormatException("negative");
            }
            return value;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_ILINK_FIELD_INVALID_" + name.toUpperCase(java.util.Locale.ROOT), error);
        }
    }

    private static long readNonNegativeLong(JsonObject object, String name) throws IOException {
        try {
            long value = object.get(name).getAsLong();
            if (value < 0L) {
                throw new NumberFormatException("negative");
            }
            return value;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_ILINK_FIELD_INVALID_" + name.toUpperCase(java.util.Locale.ROOT), error);
        }
    }

    private static String readStringOrDefault(JsonObject object, String name, String fallback) {
        JsonElement value = object.get(name);
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString()
                ? value.getAsString() : fallback;
    }

    private static String readErrorCode(JsonObject payload) {
        return safeErrorCode(readStringOrDefault(payload, "code", null), "CLAWBOT_ILINK_OPERATION_FAILED");
    }

    private static String safeErrorCode(String value, String fallback) {
        if (value == null || value.isBlank() || value.length() > 128
                || value.chars().anyMatch(character -> !((character >= 'A' && character <= 'Z')
                || (character >= '0' && character <= '9') || character == '_'))) {
            return fallback;
        }
        return value;
    }

    private static String describeOutboundError(Throwable error, String fallback) {
        String code = safeErrorCode(error == null ? null : error.getMessage(), fallback);
        if (error != null && error.getCause() instanceof ClawBotIlinkProcess.IlinkDaemonException daemonError) {
            String detail = daemonError.detail();
            if (detail != null && detail.matches("(?:ret|errcode|http|retryAfterMs)=-?[0-9]+(?:;(?:ret|errcode|http|retryAfterMs)=-?[0-9]+)*")) {
                return code + " (" + detail + ")";
            }
        }
        return code;
    }

    private static long retryAfterMillis(Throwable error) {
        if (error.getCause() instanceof ClawBotIlinkProcess.IlinkDaemonException daemon && daemon.detail() != null) {
            for (String field : daemon.detail().split(";")) {
                if (field.matches("retryAfterMs=[0-9]{1,8}")) {
                    return Long.parseLong(field.substring("retryAfterMs=".length()));
                }
            }
        }
        return ClawBotOutboundProtection.WINDOW_MILLIS;
    }

    private JsonObject sessionsPayload() {
        JsonObject payload = new JsonObject();
        payload.add("sessions", ClawBotSessionWireCodec.snapshotsToJson(sessionRegistry.snapshot()));
        return payload;
    }

    private ClawBotIpcEnvelope response(ClawBotIpcEnvelope request, String type, JsonObject payload) {
        return new ClawBotIpcEnvelope(
                ClawBotIpcEnvelope.PROTOCOL_VERSION,
                type,
                request.requestId(),
                instanceId,
                connectionEpoch,
                payload);
    }

    private ClawBotIpcEnvelope acceptedResponse(
            ClawBotIpcEnvelope request, String type, String deliveryStatus) {
        JsonObject payload = new JsonObject();
        payload.addProperty("accepted", true);
        payload.addProperty("deliveryStatus", deliveryStatus);
        return response(request, type, payload);
    }

    private ClawBotIpcEnvelope pendingResponse(ClawBotIpcEnvelope request, String type) {
        JsonObject payload = new JsonObject();
        payload.addProperty("accepted", false);
        payload.addProperty("deliveryStatus", "PENDING");
        return response(request, type, payload);
    }

    private ClawBotIpcEnvelope errorResponse(ClawBotIpcEnvelope request, String code) {
        JsonObject payload = new JsonObject();
        payload.addProperty("code", code);
        return response(request, "ERROR", payload);
    }

    private void publishCurrentSessions() {
        mockChannel.publishSessions(sessionRegistry.snapshot());
    }

    private static JsonObject requireObject(JsonObject object, String name) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonObject()) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        return value.getAsJsonObject();
    }

    private static String readString(JsonObject object, String name) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()
                || value.getAsString().isBlank()) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        return value.getAsString();
    }

    private static long readLong(JsonObject object, String name) throws IOException {
        try {
            long value = object.get(name).getAsLong();
            if (value < 0) {
                throw new NumberFormatException("negative");
            }
            return value;
        } catch (RuntimeException error) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase(), error);
        }
    }

    private static int readNonNegativeInt(JsonObject object, String name) throws IOException {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isNumber()) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase());
        }
        try {
            int parsed = value.getAsBigDecimal().intValueExact();
            if (parsed < 0) {
                throw new ArithmeticException("negative");
            }
            return parsed;
        } catch (ArithmeticException | NumberFormatException error) {
            throw new IOException("CLAWBOT_IPC_FIELD_INVALID_" + name.toUpperCase(), error);
        }
    }

    private static ClawBotSessionStatus readStatus(JsonObject object) throws IOException {
        try {
            return ClawBotSessionStatus.valueOf(readString(object, "status"));
        } catch (IllegalArgumentException error) {
            throw new IOException("CLAWBOT_IPC_STATUS_INVALID", error);
        }
    }

    private static void requireRequestOwner(ClawBotIpcEnvelope request, String instanceId, long connectionEpoch)
            throws IOException {
        if (!request.instanceId().equals(instanceId) || request.connectionEpoch() != connectionEpoch) {
            throw new IOException("CLAWBOT_IPC_OWNER_MISMATCH");
        }
    }

    private static String formatEndpoint(ClawBotLocalIpcServer.Endpoint endpoint) {
        String host = endpoint.host();
        if (host.indexOf(':') >= 0 && !host.startsWith("[")) {
            host = '[' + host + ']';
        }
        return LOOPBACK_ENDPOINT_PREFIX + host + ':' + endpoint.port();
    }

    private void ensureNotDisposed() {
        if (disposed) {
            throw new IllegalStateException("CLAWBOT_GATEWAY_DISPOSED");
        }
    }

    private static String requireValue(String value, String name) {
        if (value == null || value.isBlank() || value.length() > 256
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid " + name);
        }
        return value;
    }

    private static ThreadFactory daemonThreadFactory(String prefix) {
        AtomicInteger sequence = new AtomicInteger();
        return runnable -> {
            Thread thread = new Thread(runnable, prefix + sequence.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }

    private static void closeLease(ClawBotProcessCoordinator.LeaderLease lease) {
        if (lease != null) {
            try {
                lease.close();
            } catch (IOException ignored) {
            }
        }
    }

    private enum State {
        STOPPED,
        LEADER,
        FOLLOWER
    }
}
