package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

/** Verifies lifecycle completions cannot retire a session that replaced their owner. */
public class CodexLifecycleCompletionTest {
    /** Isolates ownership and configuration from real account files. */
    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    /** A released preconnect may fail after the replacement session is already ready. */
    @Test
    public void latePreconnectFailureLeavesTheReplacementSessionUsable() throws Exception {
        ControlledDaemon daemon = new ControlledDaemon();
        String scope = this.folder.newFolder("home").getAbsolutePath();
        CodexSDKBridge bridge = new CodexSDKBridge(this.folder.getRoot().toPath(), new FixtureSettings(), () -> daemon, scope);
        try {
            CompletableFuture<JsonObject> older = bridge.preconnectCodex("channel", scope, "old-root");
            PendingConnection oldConnection = daemon.connections.get(0);
            assertFalse(bridge.releaseCodexThread("channel", scope, "old-root").join().has("error"));
            CompletableFuture<JsonObject> newer = bridge.preconnectCodex("channel", scope, "new-root");
            PendingConnection newConnection = daemon.connections.get(1);
            assertNotEquals(oldConnection.epoch(), newConnection.epoch());
            newConnection.complete(true);
            assertFalse(newer.join().has("error"));

            oldConnection.callback().onError("Codex runtime was reset while resuming the old thread");
            oldConnection.complete(false);
            assertTrue(older.join().has("error"));
            assertFalse("the new session still accepts controls", bridge.updateCodexSettings("channel", scope,
                    new JsonObject()).has("error"));
            assertFalse("the new writer remains owned", CodexThreadOwnerRegistry.claim(scope,
                    "new-root", "another-window").acquired());
        } finally {
            bridge.cleanupAllProcesses();
            CodexThreadOwnerRegistry.releaseOwner("another-window");
        }
    }

    /** A failure belonging to the current session still drains its runtime and lease. */
    @Test
    public void currentPreconnectFailureReleasesItsWriter() throws Exception {
        ControlledDaemon daemon = new ControlledDaemon();
        String scope = this.folder.newFolder("home").getAbsolutePath();
        CodexSDKBridge bridge = new CodexSDKBridge(this.folder.getRoot().toPath(), new FixtureSettings(), () -> daemon, scope);
        try {
            CompletableFuture<JsonObject> pending = bridge.preconnectCodex("channel", scope, "root");
            PendingConnection connection = daemon.connections.get(0);
            connection.callback().onError("Native thread resume failed");
            connection.complete(false);
            assertTrue(pending.join().has("error"));
            assertTrue(bridge.updateCodexSettings("channel", scope, new JsonObject()).has("error"));
            assertTrue(CodexThreadOwnerRegistry.claim(scope, "root", "another-window").acquired());
        } finally {
            bridge.cleanupAllProcesses();
            CodexThreadOwnerRegistry.releaseOwner("another-window");
        }
    }

    private record PendingConnection(String epoch, DaemonBridge.DaemonOutputCallback callback,
                                     CompletableFuture<Boolean> result) {
        private void complete(boolean success) {
            this.callback.onComplete(success);
            this.result.complete(success);
        }
    }

    private static final class ControlledDaemon extends DaemonBridge {
        private final List<PendingConnection> connections = new ArrayList<>();
        private boolean alive;

        private ControlledDaemon() { super(null, null, null); }

        /** Replaces process startup while retaining the production lifecycle coordinator. */
        @Override
        public boolean start() { this.alive = true; return true; }

        /** Reports whether the owning coordinator has retired this daemon. */
        @Override
        public boolean isAlive() { return this.alive; }

        /** Records retirement without touching external processes. */
        @Override
        public void stop() { this.alive = false; }

        /** Allows a native resume failure to arrive after a release and a new resume. */
        @Override
        public CompletableFuture<Boolean> sendCommand(String method, JsonObject params, DaemonOutputCallback callback) {
            if (!this.alive) {
                callback.onError("Daemon is stopped");
                return CompletableFuture.completedFuture(false);
            }
            if ("codex.preconnect".equals(method)) {
                CompletableFuture<Boolean> result = new CompletableFuture<>();
                this.connections.add(new PendingConnection(params.get("sessionEpoch").getAsString(), callback, result));
                return result;
            }
            callback.onComplete(true);
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class FixtureSettings extends CodemossSettingsService {
        /** Authorizes only the isolated fixture runtime. */
        @Override
        public String getCodexRuntimeAccessMode() { return CODEX_RUNTIME_ACCESS_CLI_LOGIN; }

        /** Keeps provider capture free of real credentials. */
        @Override
        public JsonObject getActiveCodexProvider() { return new JsonObject(); }
    }
}
