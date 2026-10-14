package com.github.claudecodegui.clawbot;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringWriter;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

public class ClawBotGatewayRuntimeServiceTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void onlyPendingSentAndUnknownAreStableDeliveryStates() {
        assertTrue(ClawBotGatewayRuntimeService.isStableDeliveryState("PENDING"));
        assertTrue(ClawBotGatewayRuntimeService.isStableDeliveryState("SENT"));
        assertTrue(ClawBotGatewayRuntimeService.isStableDeliveryState("UNKNOWN"));
        assertFalse(ClawBotGatewayRuntimeService.isStableDeliveryState("FAILED"));
        assertTrue(ClawBotGatewayRuntimeService.isTerminalDeliveryState("FAILED"));
    }

    @Test
    public void persistsAndReportsProgressSettingsAcrossGatewayInstances() throws Exception {
        Path runtime = temporaryFolder.newFolder("progress-settings-runtime").toPath();
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                runtime, "gateway-instance", testHandoff());
        try {
            JsonObject defaults = service.statusSnapshot();
            assertEquals(1, defaults.get("progressTextIntervalMinutes").getAsInt());
            assertEquals(5, defaults.get("progressIdleReminderMinutes").getAsInt());
            assertEquals(10, defaults.get("progressWaitReminderMinutes").getAsInt());
            assertEquals(30, defaults.get("progressInitialCheckDelaySeconds").getAsInt());
            assertEquals(6, defaults.get("progressMaxNotifications").getAsInt());
            assertEquals(800, defaults.get("progressExcerptMaxCharacters").getAsInt());
            assertEquals(30, defaults.get("sessionIdleTimeoutMinutes").getAsInt());

            assertTrue(service.start());
            JsonObject update = new JsonObject();
            update.addProperty("textIntervalMinutes", 2);
            update.addProperty("idleReminderMinutes", 6);
            update.addProperty("waitReminderMinutes", 12);
            update.addProperty("initialCheckDelaySeconds", 20);
            update.addProperty("maxNotifications", 6);
            update.addProperty("excerptMaxCharacters", 1200);
            update.addProperty("sessionIdleTimeoutMinutes", 45);
            JsonObject updated = service.control("UPDATE_PROGRESS_SETTINGS", update);
            assertEquals(2, updated.get("progressTextIntervalMinutes").getAsInt());
            assertEquals(6, updated.get("progressIdleReminderMinutes").getAsInt());
            assertEquals(12, updated.get("progressWaitReminderMinutes").getAsInt());
            assertEquals(20, updated.get("progressInitialCheckDelaySeconds").getAsInt());
            assertEquals(6, updated.get("progressMaxNotifications").getAsInt());
            assertEquals(1200, updated.get("progressExcerptMaxCharacters").getAsInt());
            assertEquals(45, updated.get("sessionIdleTimeoutMinutes").getAsInt());

            JsonObject invalid = new JsonObject();
            invalid.add("textIntervalMinutes", com.google.gson.JsonNull.INSTANCE);
            invalid.add("idleReminderMinutes", com.google.gson.JsonNull.INSTANCE);
            invalid.add("waitReminderMinutes", com.google.gson.JsonNull.INSTANCE);
            IOException error = assertThrows(IOException.class,
                    () -> service.control("UPDATE_PROGRESS_SETTINGS", invalid));
            assertEquals("CLAWBOT_PROGRESS_SETTINGS_INVALID", error.getMessage());
            assertEquals(2, service.statusSnapshot().get("progressTextIntervalMinutes").getAsInt());
        } finally {
            service.stop();
        }

        ClawBotGatewayRuntimeService reloaded = new ClawBotGatewayRuntimeService(
                runtime, "reloaded-instance", testHandoff());
        try {
            JsonObject persisted = reloaded.statusSnapshot();
            assertEquals(2, persisted.get("progressTextIntervalMinutes").getAsInt());
            assertEquals(6, persisted.get("progressIdleReminderMinutes").getAsInt());
            assertEquals(12, persisted.get("progressWaitReminderMinutes").getAsInt());
            assertEquals(20, persisted.get("progressInitialCheckDelaySeconds").getAsInt());
            assertEquals(6, persisted.get("progressMaxNotifications").getAsInt());
            assertEquals(1200, persisted.get("progressExcerptMaxCharacters").getAsInt());
            assertEquals(45, persisted.get("sessionIdleTimeoutMinutes").getAsInt());
        } finally {
            reloaded.stop();
        }
    }

    @Test
    public void countsBridgeFilteredMessagesBeforeRouting() throws Exception {
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                temporaryFolder.newFolder("inbound-counts").toPath(), "gateway-instance", testHandoff());
        try {
            JsonObject batch = new JsonObject();
            batch.addProperty("receivedCount", 3);
            batch.addProperty("droppedCount", 2);
            service.recordInboundBatch(batch, 1);
            service.recordInboundBatch(new JsonObject(), 1);

            assertEquals(4, service.statusSnapshot().get("inboundMessageCount").getAsInt());
            assertEquals(2, service.statusSnapshot().get("inboundDroppedCount").getAsInt());

            batch.addProperty("droppedCount", 3);
            assertThrows(java.io.IOException.class, () -> service.recordInboundBatch(batch, 1));
            batch.addProperty("receivedCount", 1.5);
            assertThrows(java.io.IOException.class, () -> service.recordInboundBatch(batch, 1));
            assertEquals(4, service.statusSnapshot().get("inboundMessageCount").getAsInt());
            assertEquals(2, service.statusSnapshot().get("inboundDroppedCount").getAsInt());
        } finally {
            service.dispose();
        }
    }

    @Test
    public void malformedInboundShapesAreNormalizedForPerMessageDropHandling() {
        JsonObject invalidTarget = inboundJson("invalid-target");
        invalidTarget.addProperty("target", "not-an-object");
        JsonObject invalidRevision = inboundJson("invalid-revision");
        invalidRevision.addProperty("routeRevision", "not-a-number");

        assertThrows(IllegalArgumentException.class, () -> ClawBotInboundMessage.fromJson(invalidTarget));
        assertThrows(IllegalArgumentException.class, () -> ClawBotInboundMessage.fromJson(invalidRevision));
    }

    @Test
    public void saturatedReplyQueueRunsRejectedTaskOnSubmittingThread() throws Exception {
        CountDownLatch workerStarted = new CountDownLatch(1);
        CountDownLatch releaseWorker = new CountDownLatch(1);
        ThreadPoolExecutor executor = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                new ArrayBlockingQueue<>(1), ClawBotGatewayRuntimeService::runRejectedReplyOnCaller);
        try {
            executor.execute(() -> {
                workerStarted.countDown();
                try {
                    releaseWorker.await();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            });
            assertTrue(workerStarted.await(5, TimeUnit.SECONDS));
            executor.execute(() -> { });

            Thread submittingThread = Thread.currentThread();
            AtomicReference<Thread> executionThread = new AtomicReference<>();
            executor.execute(() -> executionThread.set(Thread.currentThread()));

            assertSame(submittingThread, executionThread.get());
        } finally {
            releaseWorker.countDown();
            executor.shutdownNow();
        }
    }

    @Test
    public void inboundCommandAndConcurrentPreviewUseGatewayBeforeRouter() throws Exception {
        assertRoutingConcurrency("/use off", false, false, null, false);
    }

    @Test
    public void navigationAndInvalidCommandsShareSafeConcurrentReplyRouting() throws Exception {
        for (String text : List.of("/help", "/whoami", "/sessions", "/status", "/use", "/use 999",
                "/continue", "/continue missing text", "/answer", "/answer 1", "/stop", "/new", "/unknown")) {
            assertRoutingConcurrency(text, false, false, null, false);
        }
    }

    @Test
    public void handleNumberAndNaturalSelectionRemainConcurrentWithPreview() throws Exception {
        for (String text : List.of("/use session-1", "/use 1", "选择 session-1")) {
            assertRoutingConcurrency(text, false, false, null, true);
        }
        assertRoutingConcurrency("选择 missing", false, false, null, false);
        assertRoutingConcurrency("/status", true, false, null, false);
    }

    @Test
    public void continuationAndNaturalControlsKeepConcurrentAdmissionSafe() throws Exception {
        assertRoutingConcurrency("/continue session-1 text", false, false, ClawBotInboundAction.MESSAGE, false);
        assertRoutingConcurrency("停止当前会话", true, false, ClawBotInboundAction.INTERRUPT, false);
        assertRoutingConcurrency("新建会话", true, false, ClawBotInboundAction.NEW_SESSION, false);
        assertRoutingConcurrency("停止当前会话", false, false, null, false);
        assertRoutingConcurrency("新建会话", false, false, null, false);
    }

    @Test
    public void explicitAndImplicitAnswersKeepConcurrentInteractionAdmissionSafe() throws Exception {
        assertRoutingConcurrency("/answer", true, true, null, false);
        for (String text : List.of("/answer 1", "Q1: 2", "/some/path")) {
            assertRoutingConcurrency(text, true, true, ClawBotInboundAction.ANSWER, false);
        }
    }

    @Test
    public void ordinaryInboundUsesSameSafeConcurrentRoutingAsCommands() throws Exception {
        assertRoutingConcurrency("short chat task", true, false, ClawBotInboundAction.MESSAGE, false);
        assertRoutingConcurrency("short chat task", false, false, null, false);
    }

    private void assertRoutingConcurrency(String text, boolean selected, boolean interaction,
            ClawBotInboundAction expectedAction, boolean expectedPreview) throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            String messageId = "lock-order-inbound";
            CountDownLatch routingEntered = new CountDownLatch(1);
            CountDownLatch releaseRouting = new CountDownLatch(1);
            AtomicBoolean testing = new AtomicBoolean();
            AtomicBoolean gatewayHeldDuringCallback = new AtomicBoolean(true);
            AtomicReference<Thread> routingThread = new AtomicReference<>();
            Field routerField = ClawBotGatewayRuntimeService.class.getDeclaredField("messageRouter");
            routerField.setAccessible(true);
            Object router = routerField.get(fixture.service);
            Runnable callbackBoundary = () -> {
                if (!testing.get()) {
                    return;
                }
                if (!Thread.holdsLock(fixture.service)) {
                    gatewayHeldDuringCallback.set(false);
                }
                routingEntered.countDown();
                try {
                    if (!releaseRouting.await(5, TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Routing release timed out: " + text);
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            };
            // Use the existing registry ticker seam to pause real admission while the router owns its monitor.
            ClawBotSessionRegistry registry = new ClawBotSessionRegistry(
                    java.time.Clock.systemUTC(), java.time.Duration.ofSeconds(30), () -> {
                        if (Thread.currentThread() == routingThread.get() && Thread.holdsLock(router)) {
                            callbackBoundary.run();
                        }
                        return System.nanoTime();
                    });
            setField(fixture.service, "sessionRegistry", registry);
            assertTrue(fixture.client.register(new ClawBotSessionRegistration(
                    "session-1", "ide-instance", "project", "Project", "codex",
                    Set.of("INBOUND", "CONTROL", "ROUTING_V2"), ClawBotSessionStatus.ONLINE, 4, "Chat", "generation-1")));
            Field replyField = ClawBotGatewayRuntimeService.class.getDeclaredField("replyExecutor");
            replyField.setAccessible(true);
            Object originalExecutor = replyField.get(fixture.service);
            ThreadPoolExecutor replies = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS,
                    new ArrayBlockingQueue<>(1)) {
                @Override
                public void execute(Runnable command) {
                    callbackBoundary.run();
                    // Keep the reply at the queue boundary; this test checks routing/IPC concurrency.
                }
            };
            ExecutorService workers = Executors.newFixedThreadPool(4);
            try (ClawBotIdeClient peer = new ClawBotIdeClient(fixture.service.endpoint(), "second-ide", 9)) {
                assertTrue(peer.register(new ClawBotSessionRegistration(
                        "session-2", "second-ide", "project-2", "Project 2", "claude",
                        Set.of("INBOUND", "CONTROL", "ROUTING_V2"), ClawBotSessionStatus.ONLINE, 9, "Chat", "generation-2")));
                replyField.set(fixture.service, replies);
                Method poll = ClawBotGatewayRuntimeService.class.getDeclaredMethod("pollInbound");
                poll.setAccessible(true);
                pollTestMessage(fixture, poll, "list-before", "/sessions");
                if (selected) {
                    pollTestMessage(fixture, poll, "select-before", "/use session-1");
                    Field mailbox = ClawBotGatewayRuntimeService.class.getDeclaredField("previewMailbox");
                    mailbox.setAccessible(true);
                    ((ClawBotPreviewMailbox) mailbox.get(fixture.service)).clear();
                }
                if (interaction) {
                    ClawBotInboundMessage source = new ClawBotInboundMessage(
                            "question-source", "sender", "context", "question").forTarget(registry.snapshot().get(0));
                    assertTrue(registry.enqueueInbound("session-1", source));
                    assertTrue(registry.markInboundDispatched("session-1", "ide-instance", 4, source.messageId()));
                    assertTrue(fixture.client.updateInteraction("session-1", source.messageId(), "question-token"));
                }
                testing.set(true);
                java.util.concurrent.Future<?> routing = workers.submit(() -> {
                    routingThread.set(Thread.currentThread());
                    try {
                        pollTestMessage(fixture, poll, messageId, text);
                    } catch (ReflectiveOperationException error) {
                        throw new IllegalStateException(error);
                    }
                });
                assertTrue("Missing routing callback: " + text, routingEntered.await(5, TimeUnit.SECONDS));
                CountDownLatch concurrentStarted = new CountDownLatch(3);
                java.util.concurrent.Future<ClawBotInboundMessage> preview = workers.submit(() -> {
                    concurrentStarted.countDown();
                    return fixture.client.pollPreview("session-1");
                });
                java.util.concurrent.Future<ClawBotInboundMessage> peerPreview = workers.submit(() -> {
                    concurrentStarted.countDown();
                    return peer.pollPreview("session-2");
                });
                java.util.concurrent.Future<JsonObject> status = workers.submit(() -> {
                    concurrentStarted.countDown();
                    return fixture.service.statusSnapshot();
                });
                assertTrue(concurrentStarted.await(5, TimeUnit.SECONDS));
                releaseRouting.countDown();

                routing.get(5, TimeUnit.SECONDS);
                ClawBotInboundMessage selectedPreview = preview.get(5, TimeUnit.SECONDS);
                assertEquals("Preview result: " + text, expectedPreview, selectedPreview != null);
                if (expectedPreview) {
                    assertEquals(messageId, selectedPreview.messageId());
                }
                assertEquals(null, peerPreview.get(5, TimeUnit.SECONDS));
                assertEquals("LEADER", status.get(5, TimeUnit.SECONDS).get("state").getAsString());
                assertTrue("Gateway/router callback order: " + text, gatewayHeldDuringCallback.get());
                ClawBotInboundMessage queued = expectedAction == ClawBotInboundAction.MESSAGE
                        ? registry.pollInbound("session-1", "ide-instance", 4)
                        : registry.pollCommand("session-1", "ide-instance", 4);
                if (expectedAction == null) {
                    assertEquals("Unexpected command admission: " + text, null, queued);
                    ClawBotInboundMessage unchanged = registry.pollInbound("session-1", "ide-instance", 4);
                    assertEquals("Unexpected provider admission: " + text, interaction ? "question-source" : null,
                            unchanged == null ? null : unchanged.messageId());
                } else {
                    assertEquals(messageId, queued.messageId());
                    assertEquals(expectedAction, queued.action());
                    if (expectedAction == ClawBotInboundAction.ANSWER) {
                        assertEquals("question-token", queued.interactionToken());
                    }
                }
            } finally {
                releaseRouting.countDown();
                workers.shutdownNow();
                replies.shutdownNow();
                replyField.set(fixture.service, originalExecutor);
            }
        }
    }

    private static void pollTestMessage(ReplyFixture fixture, Method poll, String messageId, String text)
            throws ReflectiveOperationException {
        JsonObject inbound = inboundJson(messageId);
        inbound.addProperty("text", text);
        JsonObject updates = new JsonObject();
        com.google.gson.JsonArray messages = new com.google.gson.JsonArray();
        messages.add(inbound);
        updates.add("messages", messages);
        fixture.transport.inboundUpdates = updates;
        poll.invoke(fixture.service);
    }

    @Test
    public void leaderServesSessionRegistrationAndMockChannelUpdates() throws Exception {
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                temporaryFolder.newFolder("leader-runtime").toPath(), "gateway-instance", testHandoff());
        try {
            assertTrue(service.start());
            try (ClawBotIdeClient client = new ClawBotIdeClient(service.endpoint(), "ide-instance", 4)) {
                ClawBotSessionRegistration registration = registration(ClawBotSessionStatus.ONLINE);

                assertTrue(client.register(registration));
                assertEquals(1, client.listSessions().size());
                assertEquals(1, service.mockChannel().sessions().size());
                assertTrue(client.heartbeat("session-1", ClawBotSessionStatus.BUSY));
                assertEquals(ClawBotSessionStatus.BUSY, client.listSessions().get(0).status());
                assertTrue(client.replaceSnapshot(List.of(registration(ClawBotSessionStatus.ONLINE))));
                assertEquals(ClawBotSessionStatus.ONLINE, client.listSessions().get(0).status());
                assertTrue(client.unregister("session-1"));
                assertTrue(client.listSessions().isEmpty());
                assertTrue(service.mockChannel().revision() >= 4);
            }
        } finally {
            service.stop();
        }
    }

    @Test
    public void periodicHeartbeatKeepsLatestBusyStatus() throws Exception {
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                temporaryFolder.newFolder("heartbeat-runtime").toPath(), "gateway-instance", testHandoff());
        try {
            assertTrue(service.start());
            try (ClawBotIdeClient client = new ClawBotIdeClient(service::endpoint, "ide-instance", 4, 25)) {
                assertTrue(client.register(registration(ClawBotSessionStatus.ONLINE)));
                assertTrue(client.heartbeat("session-1", ClawBotSessionStatus.BUSY));
                Thread.sleep(200);
                assertEquals(ClawBotSessionStatus.BUSY, client.listSessions().get(0).status());
            }
        } finally {
            service.stop();
        }
    }

    @Test
    public void failedSessionUpdateIsReplayedByNextHeartbeat() throws Exception {
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                temporaryFolder.newFolder("update-recovery-runtime").toPath(), "gateway-instance", testHandoff());
        AtomicBoolean failNextRequest = new AtomicBoolean();
        try {
            assertTrue(service.start());
            try (ClawBotIdeClient client = new ClawBotIdeClient(() -> {
                if (failNextRequest.getAndSet(false)) {
                    throw new java.io.IOException("simulated connection loss");
                }
                return service.endpoint();
            }, "ide-instance", 4, 25)) {
                assertTrue(client.register(registration(ClawBotSessionStatus.ONLINE)));
                failNextRequest.set(true);

                assertThrows(java.io.IOException.class,
                        () -> client.updateSession("session-1", "claude", "Renamed", "generation-2", ""));
                assertTrue(client.heartbeat("session-1", ClawBotSessionStatus.ONLINE));

                ClawBotSessionSnapshot recovered = client.listSessions().get(0);
                assertEquals("claude", recovered.provider());
                assertEquals("Renamed", recovered.tabDisplayName());
                assertEquals("generation-2", recovered.generation());
            }
        } finally {
            service.stop();
        }
    }

    @Test
    public void presentationUpdatesPreserveBusyStateAndOwnership() throws Exception {
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                temporaryFolder.newFolder("presentation-runtime").toPath(), "gateway-instance", testHandoff());
        try {
            assertTrue(service.start());
            try (ClawBotIdeClient client = new ClawBotIdeClient(service.endpoint(), "ide-instance", 4)) {
                assertTrue(client.register(registration(ClawBotSessionStatus.BUSY)));
                assertTrue(client.updatePresentation("session-1", "codex", "Investigate timeout"));
                ClawBotSessionSnapshot snapshot = client.listSessions().get(0);
                assertEquals("Investigate timeout", snapshot.tabDisplayName());
                assertEquals("codex", snapshot.provider());
                assertEquals(ClawBotSessionStatus.BUSY, snapshot.status());
                assertEquals(4, snapshot.connectionEpoch());
                assertTrue(client.updatePresentation("session-1", "codex", "Investigate timeout"));
                assertFalse(client.updatePresentation("missing", "codex", "Other tab"));
            }
        } finally {
            service.stop();
        }
    }

    @Test
    public void onlyOneRuntimeBecomesLeader() throws Exception {
        java.nio.file.Path runtime = temporaryFolder.newFolder("shared-runtime").toPath();
        ClawBotGatewayRuntimeService first = new ClawBotGatewayRuntimeService(runtime, "first", testHandoff());
        ClawBotGatewayRuntimeService second = new ClawBotGatewayRuntimeService(runtime, "second", testHandoff());
        try {
            assertTrue(first.start());
            assertFalse(second.start());
            assertTrue(first.isLeader());
            assertFalse(second.isLeader());
        } finally {
            second.stop();
            first.stop();
        }
    }

    @Test
    public void sessionGenerationAndActivityRoundTripOverIpc() throws Exception {
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                temporaryFolder.newFolder("strict-runtime").toPath(), "gateway-instance", testHandoff());
        try {
            assertTrue(service.start());
            try (ClawBotIdeClient client = new ClawBotIdeClient(service.endpoint(), "ide-instance", 4)) {
                ClawBotSessionRegistration registration = new ClawBotSessionRegistration("session-1", "ide-instance",
                        "project", "Project", "codex", Set.of("INBOUND", "CONTROL", "ROUTING_V2"),
                        ClawBotSessionStatus.ONLINE, 4, "Chat", "generation-1");
                assertTrue(client.register(registration));
                assertTrue(client.updateSession("session-1", "codex", "Chat", "generation-1", "task-1"));
                ClawBotSessionSnapshot busy = client.listSessions().get(0);
                assertEquals("generation-1", busy.generation());
                assertEquals(ClawBotSessionStatus.BUSY, busy.status());
                ClawBotInboundMessage message = new ClawBotInboundMessage("message", "sender", "context", "text").forTarget(busy);
                assertTrue(client.matchesTarget("session-1", message, "generation-1", "codex"));
                assertFalse(client.matchesTarget("session-1", message, "generation-2", "codex"));
                assertFalse(client.validateInbound("session-1", "not-queued"));
                assertEquals(null, client.pollPreview("session-1"));
                assertFalse(client.replyToPreview("session-1", "not-requested", "must not send"));
                assertTrue(client.updateSession("session-1", "claude", "Renamed", "generation-2", ""));
                ClawBotSessionSnapshot next = client.listSessions().get(0);
                assertEquals("generation-2", next.generation());
                assertEquals("Renamed", next.tabDisplayName());
                assertEquals(ClawBotSessionStatus.ONLINE, next.status());
            }
        } finally {
            service.stop();
        }
    }

    @Test
    public void rejectedInboundAndControlMessagesBecomeReplyEligibleOverIpc() throws Exception {
        Path runtime = temporaryFolder.newFolder("reject-inbound-runtime").toPath();
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                runtime, "gateway-instance", testHandoff());
        try {
            assertTrue(service.start());
            try (ClawBotIdeClient client = new ClawBotIdeClient(service.endpoint(), "ide-instance", 4)) {
                ClawBotSessionRegistration registration = new ClawBotSessionRegistration(
                        "session-1", "ide-instance", "project", "Project", "codex",
                        Set.of("STATUS", "INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE,
                        4, "Chat", "generation-1");
                assertTrue(client.register(registration));
                ClawBotSessionSnapshot session = client.listSessions().get(0);
                ClawBotSessionRegistry registry = sessionRegistry(service);
                ClawBotInboundMessage inbound = new ClawBotInboundMessage(
                        "inbound-rejected", "sender", "context", "text").forTarget(session);
                ClawBotInboundMessage control = ClawBotInboundMessage.command(
                        new ClawBotInboundMessage("control-rejected", "sender", "context", "stop"),
                        ClawBotInboundAction.INTERRUPT).forTarget(session);
                assertTrue(registry.enqueueInbound("session-1", inbound));
                assertTrue(registry.enqueueCommand("session-1", control));
                assertEquals(inbound, client.pollInbound("session-1"));
                assertEquals(control, client.pollCommand("session-1"));

                assertThrows(java.io.IOException.class,
                        () -> client.rejectInbound("session-1", inbound.messageId(), "target changed"));
                assertThrows(java.io.IOException.class,
                        () -> client.rejectCommand("session-1", control.messageId(), "target changed"));

                assertTrue(registry.isInboundDispatched(
                        "session-1", "ide-instance", 4, inbound.messageId()));
                assertTrue(registry.isCommandDispatched(
                        "session-1", "ide-instance", 4, control.messageId()));
                assertEquals(inbound, registry.pollInbound("session-1", "ide-instance", 4));
                assertEquals(control, registry.pollCommand("session-1", "ide-instance", 4));
            }
        } finally {
            service.stop();
        }
    }

    @Test
    public void terminalAndControlRepliesReachTransportOnceAndPersistReceipts() throws Exception {
        for (boolean control : List.of(false, true)) {
            try (ReplyFixture fixture = new ReplyFixture(control)) {
                if (!control) {
                    assertTrue(fixture.client.updateInteraction("session-1", "reply-message", "interaction-token"));
                    assertTrue(fixture.client.sendProgress("session-1", "reply-message", "progress-1", "Working"));
                    assertTrue(fixture.client.updateSession("session-1", "codex", "Chat", "generation-2", ""));
                }
                int before = fixture.transport.requestCount;
                assertTrue(fixture.reply());
                assertEquals("A successful reply must actually call send_text", before + 1, fixture.transport.requestCount);
                assertEquals("Final answer", fixture.transport.lastParams.get("text").getAsString());
                assertEquals("sender", fixture.transport.lastParams.get("toUserId").getAsString());
                assertEquals("context", fixture.transport.lastParams.get("contextToken").getAsString());
                assertEquals(fixture.eventId, fixture.transport.lastParams.get("clientId").getAsString());
                assertEquals("SENT", fixture.receiptStatus());
                assertEquals(null, fixture.pending());
                assertTrue(fixture.reply());
                assertEquals(before + 1, fixture.transport.requestCount);
            }
        }
    }

    @Test
    public void rejectedTransportRepliesKeepQueueAndRetryTheSameEvent() throws Exception {
        for (boolean control : List.of(false, true)) {
            try (ReplyFixture fixture = new ReplyFixture(control)) {
                fixture.transport.errorCode = "ILINK_SEND_REJECTED";
                IOException failure = assertThrows(IOException.class, fixture::reply);
                assertEquals("ILINK_SEND_REJECTED", failure.getMessage());
                assertEquals(1, fixture.transport.requestCount);
                assertEquals("FAILED", fixture.receiptStatus());
                assertEquals("reply-message", fixture.pending().messageId());

                fixture.transport.errorCode = null;
                clearDeliveryDelay(fixture.service);
                assertTrue(fixture.reply());
                assertEquals(2, fixture.transport.requestCount);
                assertEquals(fixture.eventId, fixture.transport.lastParams.get("clientId").getAsString());
                assertEquals("SENT", fixture.receiptStatus());
                assertEquals(null, fixture.pending());
            }
        }
    }

    @Test
    public void unavailableTransportDoesNotPoisonReplyRetries() throws Exception {
        for (boolean control : List.of(false, true)) {
            try (ReplyFixture fixture = new ReplyFixture(control)) {
                setField(fixture.service, "transportActive", false);
                IOException failure = assertThrows(IOException.class, fixture::reply);
                assertEquals("CLAWBOT_ILINK_TRANSPORT_NOT_READY", failure.getMessage());
                assertEquals(0, fixture.transport.requestCount);
                assertEquals("reply-message", fixture.pending().messageId());

                setField(fixture.service, "transportActive", true);
                clearDeliveryDelay(fixture.service);
                assertTrue(fixture.reply());
                assertEquals(1, fixture.transport.requestCount);
                assertEquals("SENT", fixture.receiptStatus());
                assertEquals(null, fixture.pending());
            }
        }
    }

    @Test
    public void concurrentReplyRemainsPendingUntilTransportCompletes() throws Exception {
        for (boolean control : List.of(false, true)) {
            try (ReplyFixture fixture = new ReplyFixture(control);
                 ClawBotIdeClient duplicate = new ClawBotIdeClient(fixture.service.endpoint(), "ide-instance", 4)) {
                fixture.transport.release = new CountDownLatch(1);
                ExecutorService worker = Executors.newSingleThreadExecutor();
                try {
                    java.util.concurrent.Future<Boolean> first = worker.submit(() -> { return fixture.reply(); });
                    assertTrue(fixture.transport.entered.await(5, TimeUnit.SECONDS));
                    assertFalse(fixture.reply(duplicate));
                    assertEquals("reply-message", fixture.pending().messageId());
                    fixture.transport.release.countDown();
                    assertTrue(first.get(5, TimeUnit.SECONDS));
                    assertEquals(1, fixture.transport.requestCount);
                    assertEquals("SENT", fixture.receiptStatus());
                    assertEquals(null, fixture.pending());
                } finally {
                    fixture.transport.release.countDown();
                    worker.shutdownNow();
                }
            }
        }
    }

    @Test
    public void blockedCommandDeliveryDoesNotBlockInboundBatchPreviewOrStatus() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.release = new CountDownLatch(1);
            ExecutorService workers = Executors.newFixedThreadPool(3);
            try {
                JsonObject help = inboundJson("blocked-help");
                help.addProperty("text", "/help");
                JsonObject status = inboundJson("queued-status");
                status.addProperty("text", "/status");
                com.google.gson.JsonArray messages = new com.google.gson.JsonArray();
                messages.add(help);
                messages.add(status);
                JsonObject updates = new JsonObject();
                updates.add("messages", messages);
                fixture.transport.inboundUpdates = updates;
                Method poll = ClawBotGatewayRuntimeService.class.getDeclaredMethod("pollInbound");
                poll.setAccessible(true);
                workers.submit(() -> {
                    try {
                        poll.invoke(fixture.service);
                    } catch (ReflectiveOperationException error) {
                        throw new IllegalStateException(error);
                    }
                }).get(5, TimeUnit.SECONDS);
                assertTrue(fixture.transport.entered.await(5, TimeUnit.SECONDS));
                assertEquals(null, workers.submit(() -> fixture.client.pollPreview("session-1")).get(5, TimeUnit.SECONDS));
                JsonObject snapshot = workers.submit(fixture.service::statusSnapshot).get(5, TimeUnit.SECONDS);
                assertEquals("LEADER", snapshot.get("state").getAsString());
                assertEquals(0, snapshot.get("inboundUncertainCount").getAsInt());
            } finally {
                fixture.transport.release.countDown();
                workers.shutdownNow();
                Field replies = ClawBotGatewayRuntimeService.class.getDeclaredField("replyExecutor");
                replies.setAccessible(true);
                ((ExecutorService) replies.get(fixture.service)).submit(() -> { }).get(5, TimeUnit.SECONDS);
            }
        }
    }

    @Test
    public void ambiguousTransportFailureIsNotResentOrReportedAsSent() throws Exception {
        for (boolean control : List.of(false, true)) {
            try (ReplyFixture fixture = new ReplyFixture(control)) {
                fixture.transport.errorCode = "CLAWBOT_ILINK_REQUEST_TIMEOUT";
                assertThrows(IOException.class, fixture::reply);
                assertEquals("UNKNOWN", fixture.receiptStatus());
                assertEquals("reply-message", fixture.pending().messageId());
                assertTrue(fixture.reply());
                assertEquals(1, fixture.transport.requestCount);
                assertEquals("UNKNOWN", fixture.receiptStatus());
                assertEquals(null, fixture.pending());
            }
        }
    }

    @Test
    public void unauthorizedRepliesNeverReachTransportOrConsumeTheQueue() throws Exception {
        for (boolean control : List.of(false, true)) {
            try (ReplyFixture fixture = new ReplyFixture(control)) {
                Field field = ClawBotGatewayRuntimeService.class.getDeclaredField("senderAccessStore");
                field.setAccessible(true);
                ((ClawBotSenderAccessStore) field.get(fixture.service)).revoke("sender");
                IOException failure = assertThrows(IOException.class, fixture::reply);
                assertEquals("CLAWBOT_SENDER_NOT_AUTHORIZED", failure.getMessage());
                assertEquals(0, fixture.transport.requestCount);
                assertEquals("reply-message", fixture.pending().messageId());
            }
        }
    }

    @Test
    public void followerDiscoversLeaderAndTakesOverAfterLeaderStops() throws Exception {
        Path runtime = temporaryFolder.newFolder("handoff-runtime").toPath();
        ClawBotGatewayRuntimeService first = new ClawBotGatewayRuntimeService(runtime, "first", testHandoff());
        ClawBotGatewayRuntimeService second = new ClawBotGatewayRuntimeService(runtime, "second", testHandoff());
        try {
            assertTrue(first.start());
            assertFalse(second.start());

            try (ClawBotIdeClient client = second.createIdeClient("ide-instance", 4)) {
                AtomicBoolean recovered = new AtomicBoolean();
                client.setSessionRecoveryListener(() -> recovered.set(true));
                assertTrue(client.register(registration(ClawBotSessionStatus.ONLINE)));
                String leaderJson = Files.readString(runtime.resolve("leader.json"));
                assertFalse(leaderJson.contains("gateway.auth"));
                assertFalse(leaderJson.contains("authToken"));
                assertTrue(Files.isRegularFile(runtime.resolve("gateway.auth")));

                first.stop();
                assertTrue(second.attemptTakeover());
                assertTrue(second.isLeader());
                assertTrue(second.endpoint().port() > 0);
                assertThrows(java.io.IOException.class, () -> client.pollInbound("session-1"));
                assertEquals(null, client.pollInbound("session-1"));
                assertTrue(recovered.get());
                assertTrue(client.heartbeat("session-1", ClawBotSessionStatus.ONLINE));
                assertEquals(1, client.listSessions().size());
            }
        } finally {
            second.stop();
            first.stop();
        }
    }

    @Test
    public void statusSnapshotExposesOnlySanitizedBindingState() throws Exception {
        ClawBotBindingHandoff handoff = testHandoff();
        ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                temporaryFolder.newFolder("binding-status-runtime").toPath(), "gateway-instance", handoff);
        try {
            JsonObject unbound = service.statusSnapshot();
            assertEquals("UNBOUND", unbound.get("bindingState").getAsString());
            assertEquals(0L, unbound.get("bindingRevision").getAsLong());
            assertEquals("NONE", unbound.get("bindingDiagnostic").getAsString());

            handoff.accept("fixture-bot", "https://ilinkai.weixin.qq.com", null, "fixture-token");
            JsonObject bound = service.statusSnapshot();
            assertEquals("BOUND", bound.get("bindingState").getAsString());
            assertEquals(1L, bound.get("bindingRevision").getAsLong());
            assertEquals("NONE", bound.get("bindingDiagnostic").getAsString());
            assertFalse(bound.toString().contains("fixture-token"));
            assertFalse(bound.has("botToken"));
        } finally {
            service.stop();
        }
    }

    @Test
    public void followerReadsSanitizedStatusFromLeader() throws Exception {
        Path runtime = temporaryFolder.newFolder("status-proxy-runtime").toPath();
        ClawBotBindingHandoff leaderHandoff = testHandoff();
        leaderHandoff.accept("fixture-bot", "https://ilinkai.weixin.qq.com", null, "fixture-token");
        ClawBotGatewayRuntimeService leader = new ClawBotGatewayRuntimeService(
                runtime, "leader", leaderHandoff);
        ClawBotGatewayRuntimeService follower = new ClawBotGatewayRuntimeService(
                runtime, "follower", testHandoff());
        try {
            assertTrue(leader.start());
            assertFalse(follower.start());

            JsonObject status = follower.statusSnapshot();
            assertEquals("FOLLOWER", status.get("state").getAsString());
            assertEquals("BOUND", status.get("bindingState").getAsString());
            assertFalse(status.toString().contains("fixture-token"));
        } finally {
            follower.stop();
            leader.stop();
        }
    }

    @Test
    public void followerRefreshesItsLocalProgressSettingsAfterLeaderUpdate() throws Exception {
        Path runtime = temporaryFolder.newFolder("progress-settings-follower-runtime").toPath();
        ClawBotGatewayRuntimeService leader = new ClawBotGatewayRuntimeService(
                runtime, "leader", testHandoff());
        ClawBotGatewayRuntimeService follower = new ClawBotGatewayRuntimeService(
                runtime, "follower", testHandoff());
        try {
            assertTrue(leader.start());
            assertFalse(follower.start());

            JsonObject update = new JsonObject();
            update.addProperty("textIntervalMinutes", 3);
            update.addProperty("idleReminderMinutes", 7);
            update.addProperty("waitReminderMinutes", 11);
            update.addProperty("initialCheckDelaySeconds", 18);
            update.addProperty("maxNotifications", 5);
            update.addProperty("excerptMaxCharacters", 1000);
            update.addProperty("sessionIdleTimeoutMinutes", 60);
            JsonObject result = follower.control("UPDATE_PROGRESS_SETTINGS", update);

            assertEquals("FOLLOWER", result.get("state").getAsString());
            assertEquals(3, follower.progressSettings().textIntervalMinutes());
            assertEquals(7, follower.progressSettings().idleReminderMinutes());
            assertEquals(11, follower.progressSettings().waitReminderMinutes());
            assertEquals(18, follower.progressSettings().initialCheckDelaySeconds());
            assertEquals(5, follower.progressSettings().maxNotifications());
            assertEquals(1000, follower.progressSettings().excerptMaxCharacters());
            assertEquals(60, follower.progressSettings().sessionIdleTimeoutMinutes());
        } finally {
            follower.stop();
            leader.stop();
        }
    }

    @Test
    public void followerManagesSenderAuthorizationThroughLeaderIpc() throws Exception {
        Path runtime = temporaryFolder.newFolder("sender-access-runtime").toPath();
        ClawBotGatewayRuntimeService leader = new ClawBotGatewayRuntimeService(
                runtime, "leader", testHandoff());
        ClawBotGatewayRuntimeService follower = new ClawBotGatewayRuntimeService(
                runtime, "follower", testHandoff());
        try {
            assertTrue(leader.start());
            assertFalse(follower.start());

            for (int index = 0; index < 9; index++) {
                JsonObject payload = new JsonObject();
                payload.addProperty("senderId", "fixture-sender-" + index);
                JsonObject result = follower.control("ALLOW_SENDER", payload);
                assertEquals("FOLLOWER", result.get("state").getAsString());
            }

            JsonObject status = follower.statusSnapshot();
            assertEquals(9, status.get("senderAccessCount").getAsInt());
            assertFalse(status.toString().contains("fixture-sender-"));

            JsonObject listed = follower.control("LIST_SENDERS", new JsonObject());
            assertEquals(8, listed.getAsJsonArray("authorizedSenders").size());
            assertTrue(listed.get("senderHasMore").getAsBoolean());
            assertTrue(listed.get("senderLastUsedAt").isJsonObject());
            JsonObject nextPagePayload = new JsonObject();
            nextPagePayload.addProperty("offset", 8);
            JsonObject lastPage = follower.control("LIST_SENDERS", nextPagePayload);
            assertEquals("[\"fixture-sender-8\"]", lastPage.getAsJsonArray("authorizedSenders").toString());
            assertEquals(9, lastPage.get("senderTotalCount").getAsInt());
            assertFalse(follower.statusSnapshot().has("authorizedSenders"));
            assertFalse(follower.statusSnapshot().has("senderLastUsedAt"));

            JsonObject revokePayload = new JsonObject();
            revokePayload.addProperty("senderId", "fixture-sender-0");
            follower.control("REVOKE_SENDER", revokePayload);
            assertEquals(8, follower.statusSnapshot().get("senderAccessCount").getAsInt());
            JsonObject remaining = follower.control("LIST_SENDERS", new JsonObject());
            assertEquals(8, remaining.getAsJsonArray("authorizedSenders").size());
            assertFalse(remaining.getAsJsonArray("authorizedSenders").toString().contains("fixture-sender-0"));
        } finally {
            follower.stop();
            leader.stop();
        }
    }

    private static ClawBotBindingHandoff testHandoff() {
        return new ClawBotBindingHandoff(
                new ClawBotCredentialStore(new FakeCredentialBackend()),
                new ClawBotBindingMetadataStore(new FakeMetadataBackend()));
    }

    private static JsonObject inboundJson(String messageId) {
        JsonObject inbound = new JsonObject();
        inbound.addProperty("messageId", messageId);
        inbound.addProperty("fromUserId", "sender");
        inbound.addProperty("contextToken", "context");
        inbound.addProperty("text", "text");
        return inbound;
    }

    private static ClawBotSessionRegistry sessionRegistry(ClawBotGatewayRuntimeService service)
            throws ReflectiveOperationException {
        java.lang.reflect.Field field = ClawBotGatewayRuntimeService.class.getDeclaredField("sessionRegistry");
        field.setAccessible(true);
        return (ClawBotSessionRegistry) field.get(service);
    }

    private static void clearDeliveryDelay(ClawBotGatewayRuntimeService service) throws Exception {
        Field field = ClawBotGatewayRuntimeService.class.getDeclaredField("deliveryRetryAt");
        field.setAccessible(true);
        ((Map<?, ?>) field.get(service)).clear();
    }

    private static void setField(Object target, String name, Object value) throws ReflectiveOperationException {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @Test
    public void pollingDoesNotShortenRejectedDeliveryDeadline() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_REJECTED";
            assertThrows(IOException.class, fixture::reply);
            Field field = ClawBotGatewayRuntimeService.class.getDeclaredField("deliveryRetryAt");
            field.setAccessible(true);
            java.util.Map<?, ?> deadlines = (java.util.Map<?, ?>) field.get(fixture.service);
            Object deadline = deadlines.get(fixture.eventId);
            assertTrue((Long) deadline > System.currentTimeMillis() + 290_000L);
            Method retry = ClawBotGatewayRuntimeService.class.getDeclaredMethod("retryPendingDeliveries");
            retry.setAccessible(true);
            retry.invoke(fixture.service);
            assertEquals("CLAWBOT_SEND_DEFERRED", assertThrows(IOException.class, fixture::reply).getMessage());
            assertEquals(deadline, deadlines.get(fixture.eventId));
            assertEquals(1, fixture.transport.requestCount);
        }
    }

    @Test
    public void ambiguousStartDoesNotConsumeUnattemptedProgress() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false, false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, () -> fixture.client.sendProgress(
                    "session-1", "reply-message", "reply-message:start", "Started"));
            fixture.transport.errorCode = null;
            assertTrue(fixture.client.sendProgress("session-1", "reply-message", "progress-after-unknown", "New progress"));
            assertEquals(2, fixture.transport.requestCount);
            assertEquals("New progress", fixture.transport.lastParams.get("text").getAsString());
        }
    }

    @Test
    public void staleDeliverySnapshotCannotAcquireNewGeneration() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_REJECTED";
            assertThrows(IOException.class, fixture::reply);
            var delivery = new ClawBotPendingDeliveryStore(fixture.runtime).pending("fixture-token").get(0);
            Field generation = ClawBotGatewayRuntimeService.class.getDeclaredField("outboundGeneration");
            generation.setAccessible(true);
            long oldGeneration = generation.getLong(fixture.service);
            Method clear = ClawBotGatewayRuntimeService.class.getDeclaredMethod("clearOutboundDeliveryState");
            clear.setAccessible(true);
            clear.invoke(fixture.service);
            fixture.transport.errorCode = null;
            Method deliver = ClawBotGatewayRuntimeService.class.getDeclaredMethod("deliverPending",
                    ClawBotPendingDeliveryStore.Delivery.class, long.class);
            deliver.setAccessible(true);
            var error = assertThrows(java.lang.reflect.InvocationTargetException.class,
                    () -> deliver.invoke(fixture.service, delivery, oldGeneration));
            assertEquals("CLAWBOT_OUTBOUND_CANCELLED", error.getCause().getMessage());
            assertEquals(1, fixture.transport.requestCount);
        }
    }

    @Test
    public void durableReplyCapabilitySurvivesLossOfVolatileInboundQueue() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            sessionRegistry(fixture.service).clearPendingMessages();
            Field field = ClawBotGatewayRuntimeService.class.getDeclaredField("replyCapabilities");
            field.setAccessible(true);
            ((ClawBotPendingDeliveryStore) field.get(fixture.service)).reload();
            assertTrue(fixture.reply());
            assertEquals(1, fixture.transport.requestCount);
            assertEquals("Final answer", fixture.transport.lastParams.get("text").getAsString());
            assertTrue(new ClawBotPendingDeliveryStore(fixture.runtime, "reply-capabilities.enc")
                    .pending("fixture-token").isEmpty());
        }
    }

    @Test
    public void revokedSenderCannotRecoverDurableReplyCapability() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            JsonObject request = new JsonObject();
            request.addProperty("senderId", "sender");
            fixture.service.control("REVOKE_SENDER", request);
            assertThrows(IOException.class, fixture::reply);
            assertEquals(0, fixture.transport.requestCount);
            assertTrue(new ClawBotPendingDeliveryStore(fixture.runtime, "reply-capabilities.enc")
                    .pending("fixture-token").isEmpty());
        }
    }

    @Test
    public void replacedSessionGenerationCannotRecoverOldFinal() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            sessionRegistry(fixture.service).clearPendingMessages();
            assertTrue(fixture.client.register(new ClawBotSessionRegistration(
                    "session-1", "ide-instance", "project", "Project", "codex",
                    Set.of("INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 4, "Chat", "generation-2")));
            assertEquals("CLAWBOT_SESSION_MESSAGE_NOT_PENDING", assertThrows(IOException.class, fixture::reply).getMessage());
            assertEquals(0, fixture.transport.requestCount);
        }
    }

    @Test
    public void newGatewayAcceptsFinalForSurvivingIdeTaskWithoutReexecution() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.service.stop();
            ClawBotBindingHandoff handoff = testHandoff();
            ClawBotGatewayRuntimeService replacement = new ClawBotGatewayRuntimeService(fixture.runtime, "replacement", handoff);
            try {
                assertTrue(replacement.start());
                handoff.accept("fixture-bot", "https://ilinkai.weixin.qq.com", null, "fixture-token");
                RecordingTransport transport = new RecordingTransport();
                setField(replacement, "ilinkProcess", transport.bridge);
                setField(replacement, "transportActive", true);
                JsonObject authorization = new JsonObject();
                authorization.addProperty("senderId", "sender");
                replacement.control("ALLOW_SENDER", authorization);
                try (ClawBotIdeClient surviving = new ClawBotIdeClient(replacement.endpoint(), "ide-instance", 4)) {
                    assertTrue(surviving.register(new ClawBotSessionRegistration(
                            "session-1", "ide-instance", "project", "Project", "codex",
                            Set.of("INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 4, "Chat", "generation-1")));
                    assertEquals(null, surviving.pollInbound("session-1"));
                    assertTrue(surviving.replyToInbound("session-1", "reply-message", "Recovered final"));
                    assertEquals(1, transport.requestCount);
                    assertEquals("Recovered final", transport.lastParams.get("text").getAsString());
                }
            } finally {
                replacement.stop();
            }
        }
    }

    @Test
    public void ambiguousChunkCannotBecomeSuccessfulFinal() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, () -> fixture.client.replyToInbound(
                    "session-1", "reply-message", "x".repeat(9000)));
            fixture.transport.errorCode = null;
            Method retry = ClawBotGatewayRuntimeService.class.getDeclaredMethod("retryPendingDeliveries");
            retry.setAccessible(true);
            retry.invoke(fixture.service);
            assertEquals("UNKNOWN", fixture.receiptStatus());
            assertEquals(1, fixture.transport.requestCount);
            assertTrue(new ClawBotPendingDeliveryStore(fixture.runtime).pending("fixture-token")
                    .stream().allMatch(ClawBotPendingDeliveryStore.Delivery::unknown));
        }
    }

    @Test
    public void confirmedRecoverySendsSavedAnswerOnceAndPreservesOriginalUnknown() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, fixture::reply);
            assertEquals("UNKNOWN", fixture.receiptStatus());
            JsonObject list = fixture.service.control("LIST_REPLY_RECOVERY", new JsonObject());
            assertTrue(list.get("replyRecoveryAvailable").getAsBoolean());
            assertFalse(list.toString().contains("Final answer"));
            assertFalse(list.toString().contains("context"));
            assertFalse(list.toString().contains("\"recipient\""));
            assertEquals("READY", list.getAsJsonArray("replyRecoveryItems").get(0).getAsJsonObject().get("reason").getAsString());
            JsonObject retry = recoveryRequest(fixture);
            retry.addProperty("confirmed", false);
            assertEquals("CLAWBOT_REPLY_CONFIRMATION_REQUIRED", assertThrows(IOException.class,
                    () -> fixture.service.control("RETRY_REPLY", retry)).getMessage());
            assertEquals(1, fixture.transport.requestCount);
            retry.addProperty("confirmed", true);
            fixture.transport.errorCode = null;
            fixture.service.control("RETRY_REPLY", retry);
            assertTrue(fixture.transport.entered.await(5, TimeUnit.SECONDS));
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (fixture.transport.requestCount < 2 && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            fixture.service.control("RETRY_REPLY", retry);
            assertEquals(2, fixture.transport.requestCount);
            assertEquals("Final answer", fixture.transport.lastParams.get("text").getAsString());
            assertFalse(fixture.eventId.equals(fixture.transport.lastParams.get("clientId").getAsString()));
            assertEquals("UNKNOWN", fixture.receiptStatus());
            assertTrue(fixture.reply());
            assertEquals(null, fixture.pending());
            assertEquals(2, fixture.transport.requestCount);
        }
    }

    @Test
    public void recoveryRejectsStaleBindingTargetAndRevokedSender() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, fixture::reply);
            JsonObject retry = recoveryRequest(fixture);
            long revision = retry.get("bindingRevision").getAsLong();
            retry.addProperty("bindingRevision", revision + 1);
            assertEquals("CLAWBOT_REPLY_BINDING_CHANGED", assertThrows(IOException.class,
                    () -> fixture.service.control("RETRY_REPLY", retry)).getMessage());
            retry.addProperty("bindingRevision", revision);
            assertTrue(fixture.client.register(new ClawBotSessionRegistration("session-1", "ide-instance", "project", "Project", "codex",
                    Set.of("INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 4, "Chat", "replacement-generation")));
            assertEquals("CLAWBOT_REPLY_TARGET_CHANGED", assertThrows(IOException.class,
                    () -> fixture.service.control("RETRY_REPLY", retry)).getMessage());
            JsonObject revoke = new JsonObject();
            revoke.addProperty("senderId", "sender");
            fixture.service.control("REVOKE_SENDER", revoke);
            assertEquals("CLAWBOT_REPLY_BODY_UNAVAILABLE", assertThrows(IOException.class,
                    () -> fixture.service.control("RETRY_REPLY", retry)).getMessage());
            assertEquals(1, fixture.transport.requestCount);
        }
    }

    @Test
    public void recoveryRetainsWholeAnswerAfterEarlierChunkSucceeded() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            String answer = "first".repeat(1000) + "last".repeat(1000);
            assertEquals("CLAWBOT_SEND_DEFERRED", assertThrows(IOException.class,
                    () -> fixture.client.replyToInbound("session-1", "reply-message", answer)).getMessage());
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            Method retryQueued = ClawBotGatewayRuntimeService.class.getDeclaredMethod("retryPendingDeliveries");
            retryQueued.setAccessible(true);
            retryQueued.invoke(fixture.service);
            assertEquals("UNKNOWN", fixture.receiptStatus());
            ClawBotReplyRecoveryStore retained = new ClawBotReplyRecoveryStore(fixture.runtime);
            assertEquals(answer, retained.replies(System.currentTimeMillis(), "fixture-token").get(0).text());
            String source = Files.readString(fixture.runtime.resolve("outbound-receipts.json"));
            assertFalse(source.contains(answer));
            int beforeRecovery = fixture.transport.sentTexts.size();
            fixture.transport.errorCode = null;
            fixture.service.control("RETRY_REPLY", recoveryRequest(fixture));
            Field executorField = ClawBotGatewayRuntimeService.class.getDeclaredField("deliveryExecutor");
            executorField.setAccessible(true);
            ((java.util.concurrent.ExecutorService) executorField.get(fixture.service)).submit(() -> { }).get(5, TimeUnit.SECONDS);
            retryQueued.invoke(fixture.service);
            assertEquals(answer, String.join("", fixture.transport.sentTexts.subList(beforeRecovery, fixture.transport.sentTexts.size())));
            assertEquals("UNKNOWN", fixture.receiptStatus());
        }
    }

    @Test
    public void revocationWhileDisconnectedRemovesBodiesBeforeReauthorization() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, fixture::reply);
            setField(fixture.service, "transportActive", false);
            JsonObject sender = new JsonObject();
            sender.addProperty("senderId", "sender");
            fixture.service.control("REVOKE_SENDER", sender);
            fixture.service.control("ALLOW_SENDER", sender);
            setField(fixture.service, "transportActive", true);
            assertEquals("CLAWBOT_REPLY_BODY_UNAVAILABLE", assertThrows(IOException.class,
                    () -> fixture.service.control("RETRY_REPLY", recoveryRequest(fixture))).getMessage());
            assertEquals(1, fixture.transport.requestCount);
        }
    }

    @Test
    public void durableClaimWithoutQueuedDeliveryIsUnavailableAndNeverRecreated() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, fixture::reply);
            Field storeField = ClawBotGatewayRuntimeService.class.getDeclaredField("replyRecovery");
            storeField.setAccessible(true);
            ClawBotReplyRecoveryStore store = (ClawBotReplyRecoveryStore) storeField.get(fixture.service);
            store.claim(store.replies(System.currentTimeMillis(), "fixture-token").get(0), UUID.randomUUID().toString(), "fixture-token");
            store.reload();
            JsonObject result = fixture.service.control("RETRY_REPLY", recoveryRequest(fixture));
            JsonObject item = result.getAsJsonArray("replyRecoveryItems").get(0).getAsJsonObject();
            assertEquals("RETRY_STARTED", item.get("reason").getAsString());
            assertEquals("UNAVAILABLE", item.get("retryStatus").getAsString());
            assertEquals(1, fixture.transport.requestCount);
        }
    }

    @Test
    public void revocationWithMissingCredentialsCannotResurrectSavedAnswers() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, fixture::reply);
            Field bindingField = ClawBotGatewayRuntimeService.class.getDeclaredField("bindingHandoff");
            bindingField.setAccessible(true);
            ClawBotBindingHandoff handoff = (ClawBotBindingHandoff) bindingField.get(fixture.service);
            Field credentialField = ClawBotBindingHandoff.class.getDeclaredField("credentialStore");
            credentialField.setAccessible(true);
            ClawBotCredentialStore credentials = (ClawBotCredentialStore) credentialField.get(handoff);
            credentials.clearBotToken();
            JsonObject sender = new JsonObject();
            sender.addProperty("senderId", "sender");
            fixture.service.control("REVOKE_SENDER", sender);
            credentials.saveBotToken("fixture-token");
            fixture.service.control("ALLOW_SENDER", sender);
            assertEquals("CLAWBOT_REPLY_BODY_UNAVAILABLE", assertThrows(IOException.class,
                    () -> fixture.service.control("RETRY_REPLY", recoveryRequest(fixture))).getMessage());
            assertEquals(1, fixture.transport.requestCount);
        }
    }

    @Test
    public void queuedRecoveryIsDiscardedWhenOriginalTargetChangesBeforeSend() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, fixture::reply);
            Field storeField = ClawBotGatewayRuntimeService.class.getDeclaredField("replyRecovery");
            storeField.setAccessible(true);
            ClawBotReplyRecoveryStore store = (ClawBotReplyRecoveryStore) storeField.get(fixture.service);
            String retryId = UUID.randomUUID().toString();
            var reply = store.claim(store.replies(System.currentTimeMillis(), "fixture-token").get(0), retryId, "fixture-token");
            Field queueField = ClawBotGatewayRuntimeService.class.getDeclaredField("pendingDeliveries");
            queueField.setAccessible(true);
            ClawBotPendingDeliveryStore queue = (ClawBotPendingDeliveryStore) queueField.get(fixture.service);
            queue.put(new ClawBotPendingDeliveryStore.Delivery(retryId, reply.recipient(), reply.context(), reply.text(),
                    true, null, false, retryId, reply.eventId()), "fixture-token");
            assertTrue(fixture.client.register(new ClawBotSessionRegistration("session-1", "ide-instance", "project", "Project", "codex",
                    Set.of("INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 4, "Chat", "replacement-generation")));
            Method sweep = ClawBotGatewayRuntimeService.class.getDeclaredMethod("retryPendingDeliveries");
            sweep.setAccessible(true);
            sweep.invoke(fixture.service);
            assertFalse(queue.pending("fixture-token").stream().anyMatch(value -> retryId.equals(value.groupId())));
            assertEquals(1, fixture.transport.requestCount);
            assertEquals("UNKNOWN", fixture.receiptStatus());
        }
    }

    @Test
    public void ambiguousRecoveryCannotBeRepeatedByDuplicateConfirmation() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            fixture.transport.errorCode = "ILINK_SEND_RESULT_UNKNOWN";
            assertThrows(IOException.class, fixture::reply);
            JsonObject retry = recoveryRequest(fixture);
            fixture.service.control("RETRY_REPLY", retry);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (fixture.transport.requestCount < 2 && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            fixture.service.control("RETRY_REPLY", retry);
            assertEquals(2, fixture.transport.requestCount);
            assertEquals("UNKNOWN", fixture.receiptStatus());
        }
    }

    private static JsonObject recoveryRequest(ReplyFixture fixture) {
        JsonObject request = new JsonObject();
        request.addProperty("eventId", fixture.eventId);
        request.addProperty("bindingRevision", fixture.service.statusSnapshot().get("bindingRevision").getAsLong());
        request.addProperty("confirmed", true);
        return request;
    }

    /** Exercises real local IPC and receipt persistence using an in-memory daemon boundary. */
    private final class ReplyFixture implements AutoCloseable {
        private final boolean control;
        private final Path runtime = temporaryFolder.newFolder().toPath();
        private final ClawBotGatewayRuntimeService service = new ClawBotGatewayRuntimeService(
                runtime, "gateway-instance", testHandoff());
        private final RecordingTransport transport = new RecordingTransport();
        private final ClawBotIdeClient client;
        private final String eventId;

        private ReplyFixture(boolean control) throws Exception {
            this(control, true);
        }

        private ReplyFixture(boolean control, boolean sendStart) throws Exception {
            this.control = control;
            eventId = UUID.nameUUIDFromBytes(((control ? "control" : "terminal") + ":reply-message")
                    .getBytes(StandardCharsets.UTF_8)).toString();
            assertTrue(service.start());
            Field bindingField = ClawBotGatewayRuntimeService.class.getDeclaredField("bindingHandoff");
            bindingField.setAccessible(true);
            ((ClawBotBindingHandoff) bindingField.get(service)).accept(
                    "fixture-bot", "https://ilinkai.weixin.qq.com", null, "fixture-token");
            setField(service, "ilinkProcess", transport.bridge);
            setField(service, "transportActive", true);
            Field retryTask = ClawBotGatewayRuntimeService.class.getDeclaredField("deliveryRetryTask");
            retryTask.setAccessible(true);
            ((java.util.concurrent.ScheduledFuture<?>) retryTask.get(service)).cancel(false);
            JsonObject authorization = new JsonObject();
            authorization.addProperty("senderId", "sender");
            service.control("ALLOW_SENDER", authorization);
            client = new ClawBotIdeClient(service.endpoint(), "ide-instance", 4);
            assertTrue(client.register(new ClawBotSessionRegistration(
                    "session-1", "ide-instance", "project", "Project", "codex",
                    Set.of("INBOUND", "CONTROL"), ClawBotSessionStatus.ONLINE, 4, "Chat", "generation-1")));
            ClawBotInboundMessage message = new ClawBotInboundMessage("reply-message", "sender", "context", "question",
                    control ? ClawBotInboundAction.INTERRUPT : ClawBotInboundAction.MESSAGE)
                    .forTarget(client.listSessions().get(0));
            ClawBotSessionRegistry registry = sessionRegistry(service);
            if (control) {
                assertTrue(registry.enqueueCommand("session-1", message));
                assertTrue(registry.markCommandDispatched("session-1", "ide-instance", 4, message.messageId()));
            } else {
                assertTrue(registry.enqueueInbound("session-1", message));
                assertTrue(registry.markInboundDispatched("session-1", "ide-instance", 4, message.messageId()));
                if (sendStart) {
                    assertTrue(client.sendProgress("session-1", "reply-message", "reply-message:start", "Started"));
                    transport.requestCount = 0;
                    transport.entered = new CountDownLatch(1);
                }
            }
        }

        private boolean reply() throws IOException {
            return reply(client);
        }

        private boolean reply(ClawBotIdeClient caller) throws IOException {
            return control ? caller.replyToCommand("session-1", "reply-message", "Final answer")
                    : caller.replyToInbound("session-1", "reply-message", "Final answer");
        }

        private ClawBotInboundMessage pending() throws ReflectiveOperationException {
            ClawBotSessionRegistry registry = sessionRegistry(service);
            return control ? registry.pollCommand("session-1", "ide-instance", 4)
                    : registry.pollInbound("session-1", "ide-instance", 4);
        }

        private String receiptStatus() {
            return new ClawBotOutboundReceiptStore(runtime).statusOf(eventId);
        }

        @Override
        public void close() {
            client.close();
            service.stop();
        }
    }

    @Test
    public void lifecycleMessagesRemainEnabledWithZeroProgressAndFastCompletion() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false, false)) {
            JsonObject settings = ClawBotProgressSettings.defaults().toJson();
            settings.addProperty("maxNotifications", 0);
            fixture.service.control("UPDATE_PROGRESS_SETTINGS", settings);
            assertEquals("CLAWBOT_SEND_DEFERRED", assertThrows(IOException.class, fixture::reply).getMessage());
            assertEquals(1, fixture.transport.requestCount);
            clearDeliveryDelay(fixture.service);
            assertTrue(fixture.reply());
            assertEquals(2, fixture.transport.requestCount);
            assertEquals("Final answer", fixture.transport.lastParams.get("text").getAsString());
            assertEquals(0, fixture.service.statusSnapshot().get("outboundQueuedCount").getAsInt());
            assertTrue(fixture.reply());
            assertEquals(2, fixture.transport.requestCount);
        }
    }

    @Test
    public void exhaustedWindowRetainsFinalAndBackgroundDeliveryDoesNotDuplicateIt() throws Exception {
        try (ReplyFixture fixture = new ReplyFixture(false)) {
            Field field = ClawBotGatewayRuntimeService.class.getDeclaredField("outboundProtection");
            field.setAccessible(true);
            ClawBotOutboundProtection protection = (ClawBotOutboundProtection) field.get(fixture.service);
            while (protection.acquire(System.currentTimeMillis(), false)) {
                // Fill the window without making a transport request.
            }
            IOException error = assertThrows(IOException.class, fixture::reply);
            assertEquals("CLAWBOT_SEND_DEFERRED", error.getMessage());
            assertEquals(0, fixture.transport.requestCount);
            assertEquals(1, fixture.service.statusSnapshot().get("outboundQueuedCount").getAsInt());
            Field attempts = ClawBotOutboundProtection.class.getDeclaredField("attempts");
            attempts.setAccessible(true);
            ((java.util.Deque<?>) attempts.get(protection)).clear();
            clearDeliveryDelay(fixture.service);
            Method retry = ClawBotGatewayRuntimeService.class.getDeclaredMethod("retryPendingDeliveries");
            retry.setAccessible(true);
            retry.invoke(fixture.service);
            assertEquals(1, fixture.transport.requestCount);
            assertEquals("SENT", fixture.receiptStatus());
            assertTrue(fixture.reply());
            assertEquals(1, fixture.transport.requestCount);
        }
    }

    /** Never starts Node or contacts WeChat; replies through the real daemon response parser. */
    private static final class RecordingTransport extends Process {
        private final ClawBotIlinkProcess bridge = new ClawBotIlinkProcess();
        private volatile CountDownLatch entered = new CountDownLatch(1);
        private volatile CountDownLatch release;
        private volatile String errorCode;
        private volatile int requestCount;
        private volatile JsonObject lastParams;
        private volatile JsonObject inboundUpdates;
        private final java.util.List<String> sentTexts = new java.util.concurrent.CopyOnWriteArrayList<>();
        private boolean alive = true;

        private RecordingTransport() throws ReflectiveOperationException {
            Method dispatch = ClawBotIlinkProcess.class.getDeclaredMethod("dispatchLine", String.class, CompletableFuture.class);
            dispatch.setAccessible(true);
            StringWriter output = new StringWriter();
            BufferedWriter writer = new BufferedWriter(output) {
                @Override
                public void flush() throws IOException {
                    super.flush();
                    JsonObject request = JsonParser.parseString(output.toString().trim()).getAsJsonObject();
                    output.getBuffer().setLength(0);
                    if ("get_updates".equals(request.get("method").getAsString())) {
                        JsonObject response = new JsonObject();
                        response.add("id", request.get("id"));
                        response.add("result", inboundUpdates.deepCopy());
                        try {
                            dispatch.invoke(bridge, response.toString(), CompletableFuture.completedFuture(null));
                        } catch (ReflectiveOperationException error) {
                            throw new IOException(error);
                        }
                        return;
                    }
                    assertEquals("send_text", request.get("method").getAsString());
                    lastParams = request.getAsJsonObject("params").deepCopy();
                    sentTexts.add(lastParams.get("text").getAsString());
                    requestCount++;
                    entered.countDown();
                    try {
                        if (release != null && !release.await(5, TimeUnit.SECONDS)) {
                            throw new IOException("TEST_TRANSPORT_TIMEOUT");
                        }
                        JsonObject response = new JsonObject();
                        response.add("id", request.get("id"));
                        if (errorCode == null) {
                            response.add("result", new JsonObject());
                        } else {
                            JsonObject error = new JsonObject();
                            error.addProperty("code", errorCode);
                            response.add("error", error);
                        }
                        dispatch.invoke(bridge, response.toString(), CompletableFuture.completedFuture(null));
                    } catch (ReflectiveOperationException | InterruptedException error) {
                        throw new IOException(error);
                    }
                }
            };
            setField(bridge, "process", this);
            setField(bridge, "writer", writer);
        }

        @Override public OutputStream getOutputStream() { return OutputStream.nullOutputStream(); }
        @Override public InputStream getInputStream() { return InputStream.nullInputStream(); }
        @Override public InputStream getErrorStream() { return InputStream.nullInputStream(); }
        @Override public int waitFor() { return 0; }
        @Override public int exitValue() { if (alive) { throw new IllegalThreadStateException(); } return 0; }
        @Override public void destroy() { alive = false; }
        @Override public boolean isAlive() { return alive; }
    }

    private static ClawBotSessionRegistration registration(ClawBotSessionStatus status) {
        return new ClawBotSessionRegistration(
                "session-1",
                "ide-instance",
                "project-1",
                "Demo Project",
                "codex",
                Set.of("STATUS", "CONTINUE"),
                status,
                4);
    }

    private static final class FakeCredentialBackend implements ClawBotCredentialStore.SecretBackend {

        private final Map<String, String> values = new HashMap<>();

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
    }

    private static final class FakeMetadataBackend implements ClawBotBindingMetadataStore.MetadataBackend {

        private final Map<String, String> values = new HashMap<>();

        @Override
        public String read(String key) {
            return values.get(key);
        }

        @Override
        public void write(String key, String value) {
            values.put(key, value);
        }
    }
}
