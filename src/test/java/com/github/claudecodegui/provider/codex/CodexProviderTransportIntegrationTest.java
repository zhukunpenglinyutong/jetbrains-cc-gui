package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.CodexFixtureDaemon;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.CallbackHandler;
import com.github.claudecodegui.session.CodexMessageHandler;
import com.github.claudecodegui.session.SessionState;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Exercises provider event routing, native controls and logical writer release over real stdio. */
public class CodexProviderTransportIntegrationTest {
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    /** History reads and controls cannot steal live messages before the native terminal. */
    @Test
    public void liveTextAndReasoningReachJavaBeforeTheNativeTerminalAfterHistoryRead() throws Exception {
        try (Fixture fixture = this.fixture("streaming-before-terminal")) {
            JsonObject read = fixture.bridge.readCodexNative("codex.readThread", "fixture", fixture.cwd.toString(),
                    "th-test-root-0001", new JsonObject()).get(15, TimeUnit.SECONDS);
            assertFalse(read.toString(), read.has("error"));
            CompletableFuture<SDKResult> send = fixture.send();
            JsonObject approval = fixture.awaitEvent("interactionRequested");
            assertFalse(send.isDone());
            assertTrue(fixture.callback.messages.stream().anyMatch(message -> message.contains("first and second")));
            assertTrue(fixture.callback.messages.stream().anyMatch(message -> message.contains("live reasoning")));
            JsonObject thinkingStarted = fixture.callback.messages.stream().filter(message -> message.startsWith("assistant:"))
                    .map(message -> JsonParser.parseString(message.substring("assistant:".length())))
                    .map(value -> value.getAsJsonObject()).filter(message -> "empty-reasoning".equals(string(message, "codexItemId")))
                    .findFirst().orElseThrow();
            JsonObject startedBlock = thinkingStarted.getAsJsonObject("message").getAsJsonArray("content").get(0).getAsJsonObject();
            assertEquals("thinking", string(startedBlock, "type"));
            assertEquals("", string(startedBlock, "thinking"));
            assertTrue(startedBlock.get("native").getAsBoolean());
            assertEquals("inProgress", string(startedBlock, "status"));
            JsonObject decision = new JsonObject();
            decision.addProperty("decision", "accept");
            fixture.bridge.respondCodexInteraction("fixture", fixture.cwd.toString(), string(approval, "interactionKey"),
                    string(approval, "dialogToken"), decision);
            assertTrue(send.get(15, TimeUnit.SECONDS).success);
            assertEquals(1, fixture.callback.completions.get());
            JsonObject thinkingCompleted = fixture.callback.messages.stream().filter(message -> message.startsWith("assistant:"))
                    .map(message -> JsonParser.parseString(message.substring("assistant:".length())))
                    .map(value -> value.getAsJsonObject()).filter(message -> "empty-reasoning".equals(string(message, "codexItemId")))
                    .filter(message -> "completed".equals(string(message.getAsJsonObject("message")
                            .getAsJsonArray("content").get(0).getAsJsonObject(), "status"))).findFirst().orElseThrow();
            assertEquals(string(thinkingStarted, "uuid"), string(thinkingCompleted, "uuid"));
            JsonObject readableCompleted = fixture.callback.messages.stream().filter(message -> message.startsWith("assistant:"))
                    .map(message -> JsonParser.parseString(message.substring("assistant:".length())).getAsJsonObject())
                    .filter(message -> "live-reasoning".equals(string(message, "codexItemId")))
                    .filter(message -> "completed".equals(string(message.getAsJsonObject("message")
                            .getAsJsonArray("content").get(0).getAsJsonObject(), "status"))).findFirst().orElseThrow();
            assertEquals("live reasoning", string(readableCompleted.getAsJsonObject("message")
                    .getAsJsonArray("content").get(0).getAsJsonObject(), "thinking"));

            SessionState displayedState = new SessionState();
            CodexMessageHandler displayHandler = new CodexMessageHandler(displayedState, new CallbackHandler());
            for (String callbackMessage : fixture.callback.messages) {
                if (callbackMessage.startsWith("assistant:")) {
                    displayHandler.onMessage("assistant", callbackMessage.substring("assistant:".length()));
                }
            }
            var displayedThoughts = displayedState.getMessages().stream()
                    .filter(message -> "live-reasoning".equals(string(message.raw, "codexItemId"))).toList();
            assertEquals(1, displayedThoughts.size());
            JsonObject displayedBlock = displayedThoughts.get(0).raw.getAsJsonObject("message")
                    .getAsJsonArray("content").get(0).getAsJsonObject();
            assertEquals("live reasoning", string(displayedBlock, "thinking"));
            assertEquals("completed", string(displayedBlock, "status"));
        }
    }

    /** A restored thread can compact before sending a message in this plugin window. */
    @Test
    public void compactAfterHistoryRestoreRoutesTheNativeBoundaryToItsSuppliedReceiver() throws Exception {
        try (Fixture fixture = this.fixture("early-notification")) {
            JsonObject result = fixture.bridge.compactCodex("fixture", fixture.cwd.toString(), "th-test-root-0001", fixture.callback)
                    .get(15, TimeUnit.SECONDS);
            assertFalse(result.toString(), result.has("error"));
            assertTrue(fixture.callback.messages.stream().anyMatch(message -> message.contains("isCompactSummary")
                    && message.contains("completed")));
            assertEquals(1, fixture.callback.completions.get());
            JsonObject effective = fixture.awaitEvent("thread/settings/updated");
            assertEquals("th-test-root-0001", string(effective, "rootThreadId"));
            assertEquals("test-model", string(effective.getAsJsonObject("payload"), "model"));
            assertFalse(fixture.trace().stream().anyMatch(event -> "thread/settings/update".equals(string(event, "method"))));
        }
    }

    /** Replayed usage must leave later replies and terminals on their own native turns. */
    @Test
    public void restoredUsageDoesNotHideRepliesBeforeAndAfterCompact() throws Exception {
        try (Fixture fixture = this.fixture("resume-replayed-usage")) {
            String threadId = "th-test-root-0001";
            assertTrue(fixture.send(threadId).get(15, TimeUnit.SECONDS).success);
            JsonObject compact = fixture.bridge.compactCodex("fixture", fixture.cwd.toString(), threadId, fixture.callback)
                    .get(15, TimeUnit.SECONDS);
            assertFalse(compact.toString(), compact.has("error"));
            assertTrue(fixture.send(threadId).get(15, TimeUnit.SECONDS).success);
            assertEquals(3, fixture.callback.completions.get());
            assertEquals(0, fixture.callback.errors.get());
            assertEquals(2, fixture.callback.messages.stream()
                    .filter(message -> message.contains("Visible restored response")).count());
            assertEquals(2, fixture.callback.messages.stream()
                    .filter(message -> message.contains("Visible restored reasoning")).count());
            assertEquals(2, fixture.callback.messages.stream()
                    .filter(message -> message.contains("echo fixture")).count());
            assertTrue(fixture.callback.messages.stream().anyMatch(message -> message.contains("isCompactSummary")));
            assertTrue(fixture.callback.events.stream().filter(event -> "operationDone".equals(string(event, "kind")))
                    .noneMatch(event -> "restored-previous-turn".equals(string(event, "turnId"))));
        }
    }

    /** Each explicit failed send settles over the real daemon without replaying a native turn. */
    @Test
    public void writerRejectionEndsEachExplicitNormalSend() throws Exception {
        try (Fixture fixture = this.fixture("resume-writer-conflict")) {
            for (int attempt = 1; attempt <= 2; attempt++) {
                SDKResult result = fixture.send("th-test-root-0001").get(15, TimeUnit.SECONDS);
                assertFalse(result.success);
                assertTrue(result.error.contains("already has an active writer"));
                assertEquals(attempt, fixture.callback.errors.get());
                assertEquals(attempt, fixture.callback.events.stream()
                        .filter(event -> "operationDone".equals(string(event, "kind"))).count());
                assertEquals(attempt, fixture.trace().stream()
                        .filter(event -> "thread/resume".equals(string(event, "method"))).count());
            }
            assertEquals(0, fixture.callback.completions.get());
            assertFalse(fixture.trace().stream().anyMatch(event -> "turn/start".equals(string(event, "method"))));
        }
    }

    /** A native writer rejection finishes the receiver before the operation result reaches the page. */
    @Test
    public void compactWriterRejectionEndsItsReceiverAndDoesNotDispatchCompaction() throws Exception {
        try (Fixture fixture = this.fixture("resume-writer-conflict")) {
            JsonObject result = fixture.bridge.compactCodex("fixture", fixture.cwd.toString(), "th-test-root-0001", fixture.callback)
                    .get(15, TimeUnit.SECONDS);
            assertTrue(result.toString(), result.get("error").getAsString().contains("already has an active writer"));
            assertTrue(result.get("errorReported").getAsBoolean());
            assertEquals(1, fixture.callback.errors.get());
            assertEquals(0, fixture.callback.completions.get());
            assertTrue(fixture.callback.events.stream().anyMatch(event -> "operationDone".equals(string(event, "kind"))));
            assertFalse(fixture.trace().stream().anyMatch(event -> "thread/compact/start".equals(string(event, "method"))));
            JsonObject second = fixture.bridge.compactCodex("fixture", fixture.cwd.toString(), "th-test-root-0001", fixture.callback)
                    .get(15, TimeUnit.SECONDS);
            assertTrue(second.has("error"));
            assertEquals(2, fixture.callback.errors.get());
            assertEquals(2, fixture.trace().stream().filter(event -> "thread/resume".equals(string(event, "method"))).count());
        }
    }

    /** Stopping a native compact closes waiting without appending a failure message. */
    @Test
    public void stoppedCompactFinishesItsReceiverWithoutReportingAnError() throws Exception {
        try (Fixture fixture = this.fixture("compact-until-interrupt")) {
            CompletableFuture<JsonObject> compact = fixture.bridge.compactCodex("fixture", fixture.cwd.toString(),
                    "th-test-root-0001", fixture.callback);
            fixture.awaitEvent("turnStarted");
            assertFalse(compact.isDone());
            assertFalse(fixture.bridge.abortCodexTurn("fixture", fixture.cwd.toString()).has("error"));
            JsonObject result = compact.get(15, TimeUnit.SECONDS);
            assertEquals("interrupted", string(result, "outcome"));
            assertEquals(1, fixture.callback.completions.get());
            assertEquals(0, fixture.callback.errors.get());
            assertFalse(result.has("errorReported"));
        }
    }

    /** The actual session Stop path can reach a compact started before the first send. */
    @Test
    public void restoredSessionStopsItsFirstCompactThroughTheNativeControlPath() throws Exception {
        try (Fixture fixture = this.fixture("compact-until-interrupt")) {
            ClaudeSession session = new ClaudeSession(null, null, fixture.bridge, null);
            session.setProvider("codex");
            session.setSessionInfo("th-test-root-0001", fixture.cwd.toString());
            CompletableFuture<JsonObject> compact = fixture.bridge.compactCodex(session.getChannelId(),
                    session.getCwd(), session.getSessionId(), fixture.callback);
            JsonObject started = fixture.awaitEvent("turnStarted");
            assertFalse(compact.isDone());
            session.interrupt().get(15, TimeUnit.SECONDS);
            assertEquals("interrupted", string(compact.get(15, TimeUnit.SECONDS), "outcome"));
            JsonObject interrupt = fixture.trace().stream()
                    .filter(event -> "turn/interrupt".equals(string(event, "method")))
                    .findFirst().orElseThrow();
            assertEquals(string(started, "turnId"), string(interrupt, "turnId"));
            assertEquals(session.getSessionId(), string(interrupt, "threadId"));
            assertEquals(1, fixture.callback.completions.get());
            assertEquals(0, fixture.callback.errors.get());
        }
    }

    /** A first restored compact cannot strand its writer in a channel the next send abandons. */
    @Test
    public void restoredCompactAndTheNextSendReuseOneNativeRuntime() throws Exception {
        try (Fixture fixture = this.fixture("early-notification")) {
            ClaudeSession session = new ClaudeSession(null, null, fixture.bridge, null);
            session.setProvider("codex");
            session.setSessionInfo("th-test-root-0001", fixture.cwd.toString());
            assertTrue(fixture.bridge.compactCodex(session.getChannelId(), session.getCwd(),
                    session.getSessionId(), fixture.callback).get(15, TimeUnit.SECONDS).get("success").getAsBoolean());
            String channel = session.launchClaude().get(5, TimeUnit.SECONDS);
            assertEquals("codex", channel);
            SDKResult reply = fixture.bridge.sendMessage(channel, "after compact", session.getSessionId(),
                    session.getCwd(), List.of(), "default", "test-model", "", "medium", null,
                    fixture.callback, "next-message", new JsonObject()).get(15, TimeUnit.SECONDS);
            assertTrue(reply.success);
            assertEquals(1, fixture.trace().stream().filter(event -> "thread/resume".equals(string(event, "method"))).count());
            assertEquals(1, fixture.trace().stream().filter(event -> "initialize".equals(string(event, "method"))).count());
            assertEquals(2, fixture.callback.completions.get());
        }
    }

    /** Compact cannot create a second writer for a thread owned by another plugin window. */
    @Test
    public void compactHonorsTheExistingWindowWriterBeforeStartingTheDaemon() throws Exception {
        try (Fixture fixture = this.fixture("early-notification")) {
            String threadId = "th-test-root-0001";
            CodexThreadOwnerRegistry.claim(fixture.scope, threadId, "foreign-window");
            try {
                JsonObject result = fixture.bridge.compactCodex("fixture", fixture.cwd.toString(), threadId, fixture.callback).get();
                assertTrue(result.get("error").getAsString().contains("already owned"));
                assertTrue(fixture.process.get() == null);
                assertFalse(Files.exists(fixture.trace));
            } finally {
                CodexThreadOwnerRegistry.releaseRelation(fixture.scope, threadId, "foreign-window");
            }
        }
    }

    @Test
    public void typedRegistryReplyReachesPeerBeforeSendFinishesAndReleaseClosesTheWriter() throws Exception {
        try (Fixture fixture = this.fixture("reverse-approval")) {
            CompletableFuture<SDKResult> send = fixture.send();
            JsonObject approval = fixture.awaitEvent("interactionRequested");
            assertTrue(approval.has("interactionKey"));
            assertFalse(send.isDone());
            assertFalse(CodexThreadOwnerRegistry.claim(fixture.scope, "th-test-root-0001", "another-window").acquired());
            JsonObject result = new JsonObject();
            result.addProperty("decision", "accept");
            JsonObject reply = fixture.bridge.respondCodexInteraction("fixture", fixture.cwd.toString(),
                    approval.get("interactionKey").getAsString(), string(approval, "dialogToken"), result);
            assertFalse(reply.toString(), reply.has("error"));
            assertTrue(send.get(15, TimeUnit.SECONDS).success);
            assertEquals(1, fixture.callback.completions.get());
            assertTrue(fixture.trace().stream().anyMatch(event -> "server_response".equals(string(event, "kind"))));
            long peerPid = fixture.peerPid();
            assertTrue(ProcessHandle.of(peerPid).orElseThrow().isAlive());
            JsonObject release = fixture.bridge.releaseCodexThread("fixture", fixture.cwd.toString(), "th-test-root-0001")
                    .get(15, TimeUnit.SECONDS);
            assertFalse(release.toString(), release.has("error"));
            assertFalse(ProcessHandle.of(peerPid).map(ProcessHandle::isAlive).orElse(false));
            assertTrue(CodexThreadOwnerRegistry.claim(fixture.scope, "th-test-root-0001", "another-window").acquired());
            CodexThreadOwnerRegistry.releaseOwner("another-window");
        }
    }

    @Test
    public void stopBeforeNativeTurnIdentityDoesNotReplayAndConfirmsProcessExit() throws Exception {
        try (Fixture fixture = this.fixture("silent-start")) {
            CompletableFuture<SDKResult> send = fixture.send();
            fixture.awaitWire("turn/start");
            assertFalse(fixture.bridge.abortCodexTurn("fixture", fixture.cwd.toString()).has("error"));
            SDKResult result = send.get(20, TimeUnit.SECONDS);
            assertFalse(result.success);
            assertEquals(1, fixture.trace().stream().filter(event -> "client_message".equals(string(event, "kind"))
                    && "turn/start".equals(string(event, "method"))).count());
            assertFalse(ProcessHandle.of(fixture.peerPid()).map(ProcessHandle::isAlive).orElse(false));
        }
    }

    @Test
    public void childApprovalRemainsRoutableAfterParentCompletes() throws Exception {
        try (Fixture fixture = this.fixture("child-interaction")) {
            CompletableFuture<SDKResult> send = fixture.send();
            JsonObject approval = fixture.awaitEvent("interactionRequested");
            assertEquals("th-test-child-0002", string(approval, "threadId"));
            assertFalse(CodexThreadOwnerRegistry.claim(fixture.scope, "th-test-child-0002", "another-window").acquired());
            assertTrue(send.get(15, TimeUnit.SECONDS).success);
            JsonObject result = new JsonObject();
            result.addProperty("decision", "decline");
            JsonObject reply = fixture.bridge.respondCodexInteraction("fixture", fixture.cwd.toString(),
                    string(approval, "interactionKey"), string(approval, "dialogToken"), result);
            assertFalse(reply.toString(), reply.has("error"));
            fixture.awaitWire("server_response");
            assertEquals(1, fixture.callback.completions.get());
        }
    }

    @Test
    public void nativeEofTriggersOneFailureCallback() throws Exception {
        try (Fixture fixture = this.fixture("disconnect-mid-turn")) {
            SDKResult result = fixture.send().get(15, TimeUnit.SECONDS);
            assertFalse(result.success);
            assertEquals(1, fixture.callback.errors.get());
            assertEquals(0, fixture.callback.completions.get());
        }
    }

    @Test
    public void inactiveNativeAccessNeverStartsTheDaemon() throws Exception {
        AtomicInteger starts = new AtomicInteger();
        CodexSDKBridge bridge = new CodexSDKBridge(this.folder.newFolder("offline").toPath(),
                new FixtureSettings("inactive"), () -> { starts.incrementAndGet(); return null; }, "offline");
        try {
            SDKResult result = bridge.sendMessage("fixture", "text", null, this.folder.getRoot().toString(),
                    List.of(), "default", "test-model", "", "medium", null, new Callback(), "client", new JsonObject()).get();
            assertFalse(result.success);
            assertEquals(0, starts.get());
        } finally { bridge.cleanupAllProcesses(); }
    }

    private Fixture fixture(String scenario) throws Exception {
        Path root = this.folder.newFolder(scenario).toPath();
        Path cwd = Files.createDirectory(root.resolve("workspace"));
        Path trace = root.resolve("trace.ndjson");
        AtomicReference<Process> process = new AtomicReference<>();
        CodexFixtureDaemon daemon = new CodexFixtureDaemon(Path.of(System.getProperty("user.dir")), root, scenario, trace, process);
        CodexSDKBridge bridge = new CodexSDKBridge(root, new FixtureSettings("cli_login"), () -> daemon, root.toString());
        return new Fixture(bridge, daemon, cwd, trace, process, root.toString());
    }

    private static String string(JsonObject object, String field) {
        return object.has(field) && object.get(field).isJsonPrimitive() ? object.get(field).getAsString() : null;
    }

    private static final class FixtureSettings extends CodemossSettingsService {
        private final String access;

        private FixtureSettings(String access) { this.access = access; }

        @Override
        public String getCodexRuntimeAccessMode() { return this.access; }

        @Override
        public JsonObject getActiveCodexProvider() { return new JsonObject(); }
    }

    private static final class Callback implements MessageCallback {
        private final List<JsonObject> events = new CopyOnWriteArrayList<>();
        private final List<String> messages = new CopyOnWriteArrayList<>();
        private final AtomicInteger errors = new AtomicInteger();
        private final AtomicInteger completions = new AtomicInteger();

        @Override
        public void onMessage(String type, String content) {
            if ("codex_runtime_event".equals(type)) this.events.add(JsonParser.parseString(content).getAsJsonObject());
            else this.messages.add(type + ":" + content);
        }

        @Override
        public void onError(String error) { this.errors.incrementAndGet(); }

        @Override
        public void onComplete(SDKResult result) { this.completions.incrementAndGet(); }
    }

    private static final class Fixture implements AutoCloseable {
        private final CodexSDKBridge bridge;
        private final CodexFixtureDaemon daemon;
        private final Path cwd;
        private final Path trace;
        private final AtomicReference<Process> process;
        private final String scope;
        private final Callback callback = new Callback();

        private Fixture(CodexSDKBridge bridge, CodexFixtureDaemon daemon, Path cwd, Path trace,
                        AtomicReference<Process> process, String scope) {
            this.bridge = bridge;
            this.daemon = daemon;
            this.cwd = cwd;
            this.trace = trace;
            this.process = process;
            this.scope = scope;
        }

        private CompletableFuture<SDKResult> send() {
            return this.send(null);
        }

        private CompletableFuture<SDKResult> send(String threadId) {
            return this.bridge.sendMessage("fixture", "fixture prompt", threadId, this.cwd.toString(),
                    List.of(), "default", "test-model", "", "medium", null, this.callback, "client", new JsonObject());
        }

        private List<JsonObject> trace() throws Exception {
            return Files.exists(this.trace) ? Files.readAllLines(this.trace).stream().filter(line -> !line.isBlank())
                    .map(JsonParser::parseString).map(element -> element.getAsJsonObject()).toList() : List.of();
        }

        private long peerPid() throws Exception {
            return this.trace().stream().filter(event -> "peer_started".equals(string(event, "kind")))
                    .findFirst().orElseThrow().get("pid").getAsLong();
        }

        private JsonObject awaitEvent(String kind) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            while (System.nanoTime() < deadline) {
                JsonObject found = this.callback.events.stream().filter(event -> kind.equals(string(event, "kind"))).findFirst().orElse(null);
                if (found != null) return found;
                Thread.sleep(20);
            }
            throw new AssertionError("missing provider event: " + kind);
        }

        private void awaitWire(String methodOrKind) throws Exception {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            while (System.nanoTime() < deadline) {
                if (this.trace().stream().anyMatch(event -> methodOrKind.equals(string(event, "method"))
                        || methodOrKind.equals(string(event, "kind")))) return;
                Thread.sleep(20);
            }
            throw new AssertionError("missing wire event: " + methodOrKind);
        }

        @Override
        public void close() throws Exception {
            Process child = this.process.get();
            List<ProcessHandle> descendants = child == null ? List.of() : child.descendants().toList();
            this.bridge.cleanupAllProcesses();
            this.daemon.stop();
            CodexThreadOwnerRegistry.releaseOwner("another-window");
            if (child != null) assertTrue(child.waitFor(10, TimeUnit.SECONDS));
            for (ProcessHandle descendant : descendants) {
                descendant.onExit().get(10, TimeUnit.SECONDS);
                assertFalse("test child was reclaimed", descendant.isAlive());
            }
        }
    }
}
