package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Checks native event delivery while an earlier send's transport is still draining. */
public class CodexControlCallbackTest {
    /** Keeps native ownership separate from real provider configuration. */
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    /** A control started after stream-end must receive its own native approvals. */
    @Test
    public void handsNativeEventsToTheControlBeforeThePreviousSendDrains() throws Exception {
        ControlledDaemon daemon = new ControlledDaemon();
        String scope = this.folder.getRoot().getAbsolutePath();
        CodexSDKBridge bridge = new CodexSDKBridge(this.folder.getRoot().toPath(),
                new FixtureSettings(), () -> daemon, scope);
        RecordingCallback previous = new RecordingCallback();
        RecordingCallback control = new RecordingCallback();
        CompletableFuture<SDKResult> send = bridge.sendMessage("channel", "question", "root", scope,
                List.of(), "default", "test-model", "", null, null, previous, "message", new JsonObject());
        try {
            assertTrue(daemon.sendStarted.await(5, TimeUnit.SECONDS));
            daemon.sendCallback.onLine("[STREAM_END]");
            CompletableFuture<JsonObject> review = bridge.reviewCodex("channel", scope, "root", control);

            bridge.handleCodexDaemonEvent("codex_event", daemon.approval(1));

            assertNotNull("the new control receives its approval", control.events.poll());
            assertTrue("the previous send must not receive the control's approval", previous.events.isEmpty());

            daemon.sendTerminal.complete(true);
            assertTrue(send.get(5, TimeUnit.SECONDS).success);
            bridge.handleCodexDaemonEvent("codex_event", daemon.approval(2));
            assertNotNull("draining the old send must preserve the control receiver", control.events.poll());
            daemon.controlTerminal.complete(true);
            assertFalse(review.get(5, TimeUnit.SECONDS).has("error"));
        } finally {
            daemon.sendTerminal.complete(true);
            daemon.controlTerminal.complete(true);
            try {
                send.get(5, TimeUnit.SECONDS);
            } finally {
                bridge.cleanupAllProcesses();
            }
        }
    }

    private static final class ControlledDaemon extends DaemonBridge {
        private final CountDownLatch sendStarted = new CountDownLatch(1);
        private final CompletableFuture<Boolean> sendTerminal = new CompletableFuture<>();
        private final CompletableFuture<Boolean> controlTerminal = new CompletableFuture<>();
        private volatile DaemonOutputCallback sendCallback;
        private volatile String epoch;
        private volatile boolean alive;

        private ControlledDaemon() {
            super(null, null, null);
        }

        /** Starts an isolated transport without an external process. */
        @Override
        public boolean start() {
            this.alive = true;
            return true;
        }

        /** Lets the production wait loop observe the fixture transport. */
        @Override
        public boolean isAlive() {
            return this.alive;
        }

        /** Retires the fixture through the production cleanup path. */
        @Override
        public void stop() {
            this.alive = false;
        }

        /** Separates native stream-end from the daemon request's completion. */
        @Override
        public CompletableFuture<Boolean> sendCommand(String method, JsonObject params,
                                                       DaemonOutputCallback callback) {
            this.epoch = params.get("sessionEpoch").getAsString();
            if ("codex.send".equals(method)) {
                this.sendCallback = callback;
                this.sendStarted.countDown();
                return this.sendTerminal;
            }
            return this.controlTerminal;
        }

        private JsonObject approval(int id) {
            JsonObject event = JsonParser.parseString("""
                    {"channelId":"channel","kind":"interactionRequested","rootThreadId":"root",
                     "threadId":"root","turnId":"review-turn","payload":{
                       "method":"item/commandExecution/requestApproval","params":{}}}
                    """).getAsJsonObject();
            event.addProperty("sessionEpoch", this.epoch);
            event.getAsJsonObject("payload").addProperty("rpcId", id);
            return event;
        }
    }

    private static final class RecordingCallback implements MessageCallback {
        private final LinkedBlockingQueue<JsonObject> events = new LinkedBlockingQueue<>();

        /** Captures the actual dialog envelope selected by the bridge. */
        @Override
        public void onMessage(String type, String content) {
            if ("codex_runtime_event".equals(type)) {
                this.events.add(JsonParser.parseString(content).getAsJsonObject());
            }
        }

        /** This fixture exercises event routing instead of error presentation. */
        @Override
        public void onError(String error) {
        }

        /** Terminal state is asserted through the operation futures. */
        @Override
        public void onComplete(SDKResult result) {
        }
    }

    private static final class FixtureSettings extends CodemossSettingsService {
        /** Authorizes only the fixture's native runtime. */
        @Override
        public String getCodexRuntimeAccessMode() {
            return CODEX_RUNTIME_ACCESS_CLI_LOGIN;
        }

        /** Avoids reading real account configuration. */
        @Override
        public JsonObject getActiveCodexProvider() {
            return new JsonObject();
        }
    }
}
