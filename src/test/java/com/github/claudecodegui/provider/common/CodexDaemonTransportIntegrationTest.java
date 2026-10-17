package com.github.claudecodegui.provider.common;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

/** Exercises the production Java daemon transport, Node service and stdio peer together. */
public class CodexDaemonTransportIntegrationTest {
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    @Test
    public void approvalReplyReachesPeerBeforeTheSendCompletes() throws Exception {
        this.exercise("reverse-approval", false);
    }

    @Test
    public void nativeEofIsReportedAsFailureInsteadOfSuccessfulSend() throws Exception {
        this.exercise("disconnect-mid-turn", true);
    }

    @Test
    public void nativeInterruptIsAGracefulUnsuccessfulCompletion() throws Exception {
        this.exercise("never-respond", false);
    }

    @Test
    public void nativeHistoryAndChildStatusStayReadOnlyAndReleaseReapsThePeer() throws Exception {
        this.exercise("native-read-only", false);
    }

    private void exercise(String scenario, boolean disconnect) throws Exception {
        Path repository = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        Path home = this.folder.newFolder("home").toPath();
        Path cwd = this.folder.newFolder("workspace").toPath();
        Path trace = home.resolve("peer-trace.ndjson");
        Path peer = repository.resolve("ai-bridge/services/codex/testing/codex-stdio-peer.js");
        AtomicReference<Process> process = new AtomicReference<>();
        DaemonBridge daemon = new DaemonBridge(null, null, null, DaemonBridge.TimeSource.system(), () -> {
            ProcessBuilder builder = new ProcessBuilder("node", repository.resolve("ai-bridge/daemon.js").toString());
            builder.directory(repository.resolve("ai-bridge").toFile());
            builder.environment().put("HOME", home.toString());
            builder.environment().put("USERPROFILE", home.toString());
            builder.environment().put("CODEX_HOME", home.resolve("codex").toString());
            Process child = builder.start();
            process.set(child);
            return child;
        }, null);
        List<JsonObject> events = new CopyOnWriteArrayList<>();
        daemon.addEventListener((kind, data) -> {
            if ("codex_event".equals(kind)) {
                events.add(data.deepCopy());
            }
        });
        try {
            assertTrue(daemon.start());
            JsonObject params = new JsonObject();
            params.addProperty("channelId", "transport-test");
            params.addProperty("sessionEpoch", "test-epoch");
            params.addProperty("cwd", cwd.toString());
            params.addProperty("message", "fixture prompt");
            params.addProperty("clientMessageId", "fixture-client-id");
            JsonArray command = new JsonArray();
            for (String argument : List.of("node", peer.toString(), "--scenario", scenario, "--trace", trace.toString())) {
                command.add(argument);
            }
            params.add("codexCommandPrefix", command);
            if ("native-read-only".equals(scenario)) {
                params.addProperty("threadId", "th-test-root-0001");
                Sink sink = new Sink();
                assertTrue(daemon.sendCommand("codex.readHistoryPage", params, sink).get(15, TimeUnit.SECONDS));
                String display = sink.result.get().toString();
                assertTrue(display.contains("tool_use"));
                assertTrue(display.contains("tool_result"));
                assertTrue(display.contains("thinking"));
                Sink messageCount = new Sink();
                assertTrue(daemon.sendCommand("codex.countThreadMessages", params, messageCount).get(15, TimeUnit.SECONDS));
                JsonObject countSnapshot = messageCount.result.get().getAsJsonObject("result");
                assertEquals("th-test-root-0001", countSnapshot.get("threadId").getAsString());
                assertEquals(5, countSnapshot.get("messageCount").getAsInt());
                JsonObject childParams = new JsonObject();
                childParams.addProperty("agentId", "th-test-child-0002");
                params.add("params", childParams);
                Sink childStatus = new Sink();
                assertTrue(daemon.sendCommand("codex.readSubagent", params, childStatus).get(15, TimeUnit.SECONDS));
                JsonObject childSnapshot = childStatus.result.get().getAsJsonObject("result");
                assertTrue(childSnapshot.get("completed").getAsBoolean());
                assertFalse(childSnapshot.has("messages"));
                List<JsonObject> wire = Files.readAllLines(trace).stream().map(JsonParser::parseString)
                        .map(element -> element.getAsJsonObject()).toList();
                assertFalse(wire.stream().anyMatch(event -> event.has("method") && List.of(
                        "thread/start", "thread/resume", "turn/start").contains(event.get("method").getAsString())));
                long peerPid = wire.stream().filter(event -> event.has("kind")
                        && "peer_started".equals(event.get("kind").getAsString())).findFirst().orElseThrow().get("pid").getAsLong();
                ProcessHandle nativePeer = ProcessHandle.of(peerPid).orElseThrow();
                assertTrue(nativePeer.isAlive());
                assertTrue(daemon.sendCommand("codex.releaseThread", params, new Sink()).get(15, TimeUnit.SECONDS));
                nativePeer.onExit().get(10, TimeUnit.SECONDS);
                assertFalse("release closed the native peer before daemon teardown", nativePeer.isAlive());
                return;
            }
            var send = daemon.sendCommand("codex.send", params, new Sink());
            if (disconnect) {
                var failure = assertThrows(java.util.concurrent.ExecutionException.class,
                        () -> send.get(15, TimeUnit.SECONDS));
                assertTrue(failure.getCause().getMessage().contains("codex runtime failure"));
            } else if ("never-respond".equals(scenario)) {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                while (events.stream().noneMatch(event -> "turnStarted".equals(event.get("kind").getAsString()))
                        && System.nanoTime() < deadline) {
                    Thread.sleep(20);
                }
                JsonObject stop = new JsonObject();
                stop.addProperty("channelId", "transport-test");
                stop.addProperty("sessionEpoch", "test-epoch");
                assertTrue(daemon.sendCommand("codex.abortTurn", stop, new Sink()).get(10, TimeUnit.SECONDS));
                assertFalse(send.get(10, TimeUnit.SECONDS));
            } else {
                JsonObject request = null;
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
                while (request == null && System.nanoTime() < deadline) {
                    request = events.stream().filter(event -> "interactionRequested".equals(
                            event.get("kind").getAsString())).findFirst().orElse(null);
                    if (request == null) {
                        Thread.sleep(20);
                    }
                }
                assertTrue("approval arrived through the production daemon listener", request != null);
                assertFalse("send still owns its FIFO slot", send.isDone());
                JsonObject response = new JsonObject();
                response.addProperty("channelId", "transport-test");
                response.addProperty("sessionEpoch", "test-epoch");
                response.add("rpcId", request.getAsJsonObject("payload").get("rpcId"));
                JsonObject result = new JsonObject();
                result.addProperty("decision", "accept");
                response.add("result", result);
                assertTrue(daemon.sendCommand("codex.respondInteraction", response, new Sink()).get(10, TimeUnit.SECONDS));
                assertTrue(send.get(10, TimeUnit.SECONDS));
                assertTrue(Files.readAllLines(trace).stream().map(JsonParser::parseString)
                        .map(element -> element.getAsJsonObject()).anyMatch(event -> event.has("kind")
                                && "server_response".equals(event.get("kind").getAsString())));
            }
        } finally {
            Process child = process.get();
            List<ProcessHandle> descendants = child == null ? List.of() : child.descendants().toList();
            daemon.stop();
            if (child != null) {
                assertTrue(child.waitFor(10, TimeUnit.SECONDS));
            }
            for (ProcessHandle descendant : descendants) {
                descendant.onExit().get(10, TimeUnit.SECONDS);
                assertFalse("native peer was reaped", descendant.isAlive());
            }
        }
    }

    private static final class Sink implements DaemonBridge.DaemonOutputCallback {
        private final AtomicReference<JsonObject> result = new AtomicReference<>();

        @Override
        public void onResult(JsonObject response) {
            this.result.set(response);
        }
        @Override
        public void onLine(String line) { }

        @Override
        public void onStderr(String text) { }

        @Override
        public void onError(String error) { }

        @Override
        public void onComplete(boolean success) { }
    }
}
