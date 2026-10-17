package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Predicate;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Integration assembly skeleton for the Codex app-server migration
 * (tasks 1.5 / 6.9 of openspec change {@code migrate-codex-to-app-server}).
 *
 * <p>The production chain is Java dispatcher/session/{@code DaemonBridge} →
 * Node daemon → {@code codex app-server --listen stdio://}. This class owns
 * the test-only assembly pieces that production never provides:
 *
 * <ul>
 *   <li><b>CLI resolver injection contract:</b> the future production assembly
 *       must accept a {@link PeerCommandProvider} that decides which argv is
 *       spawned for the Codex transport. Tests inject a provider that points
 *       at the controlled stdio peer
 *       ({@code ai-bridge/services/codex/testing/codex-stdio-peer.js});
 *       production supplies the managed/external CLI resolver and exposes no
 *       page- or user-overridable entry point for this parameter.</li>
 *   <li><b>Temporary cwd/home:</b> every test gets isolated working directory
 *       and CODEX home fixtures so the peer never touches real account data.</li>
 *   <li><b>Process observers:</b> every spawned process is tracked and the
 *       test refuses to finish while a child is still alive, so a failing test
 *       still reclaims its subprocesses.</li>
 * </ul>
 *
 * <p>Until task 6.9 wires the full provider chain, the self-check below
 * exercises only the deepest layer of the chain: a real Java-side NDJSON
 * client against the real Node stdio peer process. It observes
 * notifications-before-ack, replies a typed reverse result over the wire, and
 * cross-checks the shared sanitized trace written by the peer. This is a real
 * stdio/NDJSON exchange, not a page mock, but it does not yet prove the
 * Java→Node→peer production routing; that evidence is recorded by 6.9.
 */
public class CodexAppServerIntegrationTest {

    private static final String PEER_RELATIVE_PATH =
            "ai-bridge/services/codex/testing/codex-stdio-peer.js";

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private final ProcessObserver processObserver = new ProcessObserver();

    /**
     * Test-only injection point for the Codex transport command. The
     * production assembly class (task 6.9) takes this as a constructor
     * parameter; tests replace the managed CLI resolution with the scripted
     * peer so fixtures never require a real account.
     */
    @FunctionalInterface
    interface PeerCommandProvider {
        List<String> command(Path peerScript, Path codexHome) throws IOException;
    }

    // -------------------------------------------------------------------------
    // Self-check: real NDJSON exchange against the Node stdio peer
    // -------------------------------------------------------------------------

    @Test
    public void peerHandshakeObservesNdjsonAndReverseResult() throws Exception {
        Path peerScript = locatePeerScript();
        Path codexHome = tempFolder.newFolder("codex-home").toPath();
        Path workingDir = tempFolder.newFolder("working-dir").toPath();
        Path traceFile = tempFolder.newFile("peer-trace.ndjson").toPath();

        PeerCommandProvider peerCommandProvider =
                (script, home) -> List.of(nodeExecutable(), script.toString(),
                        "--scenario", "reverse-approval", "--trace", traceFile.toString());

        PeerProcess peer = null;
        try {
            peer = PeerProcess.start(peerCommandProvider, peerScript, codexHome,
                    workingDir, processObserver::recordStarted);

            peer.sendRequest("initialize", clientInfoFixture());
            JsonObject initializeResult = peer.awaitResponseResult("initialize", 15);
            assertEquals("codex-test-peer/1.0", initializeResult.get("userAgent").getAsString());
            peer.notify("initialized", new JsonObject());

            JsonObject turnParams = new JsonObject();
            turnParams.addProperty("threadId", "th-test-root-0001");
            peer.sendRequest("turn/start", turnParams);

            // The approval arrives as a server request carrying its own numeric
            // id, before the turn/start ack for this scenario.
            PeerProcess.ServerRequest approval = peer.awaitServerRequest(15);
            assertEquals("item/commandExecution/requestApproval", approval.method);
            assertTrue("server request id must be numeric",
                    approval.id.isJsonPrimitive() && approval.id.getAsJsonPrimitive().isNumber());

            JsonObject decision = new JsonObject();
            decision.addProperty("decision", "accept");
            peer.replyServerRequest(approval.id, decision);

            peer.awaitResponseResult("turn/start", 15);
            PeerProcess.Notification terminal = peer.awaitNotification("turn/completed", 15);
            assertEquals("completed", terminal.params.getAsJsonObject("turn")
                    .get("status").getAsString());

            peer.closeStdin();
            assertTrue("peer should exit after stdin closes", peer.waitForExit(15));

            // The shared sanitized trace proves the reverse result reached the
            // peer and counts exactly one terminal on the wire.
            List<JsonObject> trace = readTrace(traceFile);
            assertTrue(trace.stream().anyMatch(event ->
                    "server_response".equals(stringField(event, "kind"))));
            assertEquals(1, trace.stream().filter(event ->
                    "notify".equals(stringField(event, "kind"))
                            && "turn/completed".equals(stringField(event, "method"))).count());
        } finally {
            if (peer != null) {
                peer.destroyForcibly();
            }
            processObserver.assertAllTerminated();
        }
    }

    // -------------------------------------------------------------------------
    // Fixtures and helpers
    // -------------------------------------------------------------------------

    private static JsonObject clientInfoFixture() {
        JsonObject clientInfo = new JsonObject();
        clientInfo.addProperty("name", "codemoss_intellij");
        clientInfo.addProperty("title", "CC GUI");
        clientInfo.addProperty("version", "test");
        JsonObject capabilities = new JsonObject();
        capabilities.addProperty("experimentalApi", true);
        JsonObject params = new JsonObject();
        params.add("clientInfo", clientInfo);
        params.add("capabilities", capabilities);
        return params;
    }

    private static String stringField(JsonObject obj, String field) {
        return obj.has(field) && obj.get(field).isJsonPrimitive()
                ? obj.get(field).getAsString() : null;
    }

    private static List<JsonObject> readTrace(Path traceFile) throws IOException {
        List<JsonObject> events = new ArrayList<>();
        for (String line : Files.readAllLines(traceFile, StandardCharsets.UTF_8)) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            events.add(JsonParser.parseString(trimmed).getAsJsonObject());
        }
        assertEquals("traceVersion", 1, events.get(0).get("traceVersion").getAsInt());
        return events;
    }

    private Path locatePeerScript() {
        Path dir = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        for (int i = 0; i < 6 && dir != null; i++) {
            Path candidate = dir.resolve(PEER_RELATIVE_PATH);
            if (Files.exists(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new AssertionError("stdio peer script not found: " + PEER_RELATIVE_PATH);
    }

    private static String nodeExecutable() {
        String node = System.getenv("CODEX_PEER_NODE");
        return (node == null || node.trim().isEmpty()) ? "node" : node.trim();
    }

    /** Tracks every process started by a test so teardown can reclaim them. */
    private static final class ProcessObserver {
        private final ConcurrentLinkedQueue<Process> processes = new ConcurrentLinkedQueue<>();

        void recordStarted(Process process) {
            processes.add(process);
        }

        void assertAllTerminated() {
            for (Process process : processes) {
                if (process.isAlive()) {
                    process.destroyForcibly();
                }
            }
        }
    }

    /**
     * A real Node stdio peer child process with line-framed NDJSON helpers.
     * Wire entries accumulate in non-destructive lists so awaits can rescan
     * without racing the reader thread.
     */
    private static final class PeerProcess {
        private final Process process;
        private final BufferedWriter stdin;
        private final List<String> command;
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private final CountDownLatch exited = new CountDownLatch(1);

        private final List<JsonObject> responses = new CopyOnWriteArrayList<>();
        private final List<Notification> notifications = new CopyOnWriteArrayList<>();
        private final List<ServerRequest> serverRequests = new CopyOnWriteArrayList<>();

        private PeerProcess(List<String> command, Process process) {
            this.command = command;
            this.process = process;
            this.stdin = new BufferedWriter(new OutputStreamWriter(
                    process.getOutputStream(), StandardCharsets.UTF_8));
            Thread stdoutReader = new Thread(this::readStdoutLoop, "codex-peer-stdout");
            stdoutReader.setDaemon(true);
            stdoutReader.start();
            Thread stderrDrainer = new Thread(() -> drainStream(process), "codex-peer-stderr");
            stderrDrainer.setDaemon(true);
            stderrDrainer.start();
            Thread exitWatcher = new Thread(() -> {
                try {
                    process.waitFor();
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                } finally {
                    exited.countDown();
                }
            }, "codex-peer-exit");
            exitWatcher.setDaemon(true);
            exitWatcher.start();
        }

        static PeerProcess start(
                PeerCommandProvider commandProvider,
                Path peerScript,
                Path codexHome,
                Path workingDir,
                Consumer<Process> observer
        ) throws IOException {
            List<String> command = commandProvider.command(peerScript, codexHome);
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(workingDir.toFile());
            builder.environment().put("CODEX_HOME", codexHome.toString());
            Process process = builder.start();
            observer.accept(process);
            return new PeerProcess(command, process);
        }

        List<String> command() {
            return command;
        }

        void sendRequest(String method, JsonObject params) throws IOException {
            JsonObject request = new JsonObject();
            request.addProperty("id", method);
            request.addProperty("method", method);
            request.add("params", params);
            writeLine(request.toString());
        }

        void notify(String method, JsonObject params) throws IOException {
            JsonObject request = new JsonObject();
            request.addProperty("method", method);
            request.add("params", params);
            writeLine(request.toString());
        }

        void replyServerRequest(JsonElement id, JsonObject result) throws IOException {
            JsonObject response = new JsonObject();
            response.add("id", id);
            response.add("result", result);
            writeLine(response.toString());
        }

        JsonObject awaitResponseResult(String id, long timeoutSeconds)
                throws InterruptedException {
            JsonObject found = await(responses, timeoutSeconds,
                    obj -> id.equals(stringField(obj, "id")));
            assertNotNull("timed out waiting for response id=" + id, found);
            return found.getAsJsonObject("result");
        }

        Notification awaitNotification(String method, long timeoutSeconds)
                throws InterruptedException {
            Notification found = await(notifications, timeoutSeconds,
                    notification -> method.equals(notification.method));
            assertNotNull("timed out waiting for notification " + method, found);
            return found;
        }

        ServerRequest awaitServerRequest(long timeoutSeconds) throws InterruptedException {
            ServerRequest found = await(serverRequests, timeoutSeconds, request -> true);
            assertNotNull("timed out waiting for a server request", found);
            return found;
        }

        private <T> T await(List<T> source, long timeoutSeconds, Predicate<T> matcher)
                throws InterruptedException {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds);
            while (System.nanoTime() < deadline) {
                for (T entry : source) {
                    if (matcher.test(entry)) {
                        return entry;
                    }
                }
                if (!process.isAlive()) {
                    // The peer died; drain what arrived before declaring timeout.
                    break;
                }
                Thread.sleep(20);
            }
            for (T entry : source) {
                if (matcher.test(entry)) {
                    return entry;
                }
            }
            return null;
        }

        void closeStdin() throws IOException {
            if (closed.compareAndSet(false, true)) {
                stdin.flush();
                stdin.close();
            }
        }

        boolean waitForExit(long timeoutSeconds) throws InterruptedException {
            return exited.await(timeoutSeconds, TimeUnit.SECONDS);
        }

        void destroyForcibly() {
            try {
                closeStdin();
            } catch (IOException ignored) {
                // stdin already closed
            }
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }

        private void writeLine(String line) throws IOException {
            synchronized (stdin) {
                stdin.write(line);
                stdin.newLine();
                stdin.flush();
            }
        }

        private void readStdoutLoop() {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    String trimmed = line.trim();
                    if (trimmed.isEmpty()) {
                        continue;
                    }
                    JsonObject obj = JsonParser.parseString(trimmed).getAsJsonObject();
                    if (obj.has("method") && obj.has("id")) {
                        serverRequests.add(new ServerRequest(obj.get("id"),
                                obj.get("method").getAsString(), obj.getAsJsonObject("params")));
                    } else if (obj.has("method")) {
                        notifications.add(new Notification(obj.get("method").getAsString(),
                                obj.getAsJsonObject("params")));
                    } else if (obj.has("id")) {
                        responses.add(obj);
                    }
                }
            } catch (IOException ignored) {
                // Expected when the peer exits.
            }
        }

        private static void drainStream(Process process) {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                while (reader.readLine() != null) {
                    // Drain only; the peer writes no stderr in these scenarios.
                }
            } catch (IOException ignored) {
                // Expected when the peer exits.
            }
        }

        /** A server-initiated request observed on the wire. */
        static final class ServerRequest {
            final JsonElement id;
            final String method;
            final JsonObject params;

            ServerRequest(JsonElement id, String method, JsonObject params) {
                this.id = id;
                this.method = method;
                this.params = params;
            }
        }

        /** A notification observed on the wire. */
        static final class Notification {
            final String method;
            final JsonObject params;

            Notification(String method, JsonObject params) {
                this.method = method;
                this.params = params;
            }
        }
    }
}
