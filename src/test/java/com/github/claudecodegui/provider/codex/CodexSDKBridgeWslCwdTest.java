package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

public class CodexSDKBridgeWslCwdTest {
    private static final String LINUX_CWD = "/home/user/project";
    private static final String WSL_NODE = "/usr/bin/node";
    private static final String NATIVE_NODE = "C:\\Program Files\\nodejs\\node.exe";
    private static final Set<String> CWD_CARRYING_METHODS = Set.of(
            "codex.send", "codex.review", "codex.compact", "codex.preconnect", "codex.releaseThread",
            "codex.executePlan", "codex.listSkills", "codex.abortTurn", "codex.updateSettings");

    @Rule
    public TemporaryFolder folder = new TemporaryFolder();

    private String previousNode;

    @Before
    public void rememberNode() {
        assumeTrue(System.getProperty("os.name").startsWith("Windows"));
        this.previousNode = NodeDetector.getInstance().getCachedNodePath();
    }

    @After
    public void restoreNode() {
        if (this.previousNode != null || System.getProperty("os.name").startsWith("Windows")) {
            NodeDetector.getInstance().setNodeExecutable(this.previousNode);
        }
    }

    @Test
    public void sendsLinuxCwdForWslUncProjectWhenNodeRunsInWsl() throws Exception {
        NodeDetector.getInstance().setNodeExecutable(WSL_NODE);
        for (String uncCwd : new String[]{"//wsl.localhost/Ubuntu/home/user/project",
                "\\\\wsl.localhost\\Ubuntu\\home\\user\\project",
                "\\\\wsl$\\Ubuntu\\home\\user\\project"}) {
            assertEveryOperationSends(uncCwd, LINUX_CWD, null);
        }
    }

    @Test
    public void sendsMountPathForDriveLetterProjectWhenNodeRunsInWsl() throws Exception {
        NodeDetector.getInstance().setNodeExecutable(WSL_NODE);
        assertEveryOperationSends("C:\\work\\project", "/mnt/c/work/project", null);
    }

    @Test
    public void keepsCwdUnchangedWhenNodeIsNative() throws Exception {
        NodeDetector.getInstance().setNodeExecutable(NATIVE_NODE);
        assertEveryOperationSends("C:\\work\\project", "C:\\work\\project", null);
    }

    /** A live daemon keeps the node it started with, so a settings change must not retarget its paths. */
    @Test
    public void followsTheLiveDaemonsNodeInsteadOfTheSetting() throws Exception {
        NodeDetector.getInstance().setNodeExecutable(WSL_NODE);
        String uncCwd = "//wsl.localhost/Ubuntu/home/user/project";
        assertEveryOperationSends(uncCwd, uncCwd, NATIVE_NODE);

        NodeDetector.getInstance().setNodeExecutable(NATIVE_NODE);
        assertEveryOperationSends(uncCwd, LINUX_CWD, WSL_NODE);
    }

    /** The daemon runs in one distro, where the same path may be a different project. */
    @Test
    public void refusesToSendWhenTheProjectIsInAnotherDistro() throws Exception {
        NodeDetector.getInstance().setNodeExecutable(WSL_NODE);
        String otherDistroCwd = "//wsl.localhost/Debian/home/user/project";
        RecordingDaemon daemon = new RecordingDaemon(null, "Ubuntu");
        CodexSDKBridge bridge = newBridge(daemon);
        AtomicReference<String> error = new AtomicReference<>();
        try {
            bridge.sendMessage("channel", "question", "root", otherDistroCwd, List.of(), "default", "test-model",
                    "", null, null, new NoopCallback() {
                        @Override
                        public void onError(String message) {
                            error.set(message);
                        }
                    }, "message", new JsonObject()).get();

            assertNotNull("the user must learn why nothing ran", error.get());
            assertTrue(error.get(), error.get().contains("Debian") && error.get().contains("Ubuntu"));
            assertFalse("the turn must not start in the wrong distro", daemon.cwdByMethod.containsKey("codex.send"));

            // Other calls must fail in Codex instead of silently reading the same path in the wrong distro.
            bridge.reviewCodex("channel", otherDistroCwd, "root", new NoopCallback());
            awaitMethods(daemon, Set.of("codex.review"));
            assertEquals(otherDistroCwd, daemon.cwdByMethod.get("codex.review"));
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    @Test
    public void attachmentPathsAreLinuxPathsWhenNodeRunsInWsl() throws Exception {
        NodeDetector.getInstance().setNodeExecutable(WSL_NODE);
        CodexSDKBridge bridge = newBridge(new RecordingDaemon(null, "Ubuntu"));
        try {
            JsonArray attachments = bridge.buildCodexAttachments(
                    List.of(new ClaudeSession.Attachment("a.png", "image/png", "aGVsbG8=")));

            String path = attachments.get(0).getAsJsonObject().get("path").getAsString();
            assertTrue(path, path.startsWith("/") && !path.contains("\\"));
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    private void assertEveryOperationSends(String cwd, String expectedCwd, String daemonNode) throws Exception {
        RecordingDaemon daemon = new RecordingDaemon(daemonNode, "Ubuntu");
        CodexSDKBridge bridge = newBridge(daemon);
        try {
            exerciseEveryCwdCarryingOperation(bridge, cwd);
            awaitMethods(daemon, CWD_CARRYING_METHODS);
            assertEquals(CWD_CARRYING_METHODS, daemon.cwdByMethod.keySet());
            for (Map.Entry<String, String> sent : daemon.cwdByMethod.entrySet()) {
                assertEquals(sent.getKey() + " for " + cwd, expectedCwd, sent.getValue());
            }
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    private CodexSDKBridge newBridge(RecordingDaemon daemon) {
        String scope = this.folder.getRoot().getAbsolutePath() + daemon.hashCode();
        return new CodexSDKBridge(this.folder.getRoot().toPath(), new FixtureSettings(), () -> daemon, scope);
    }

    private static void exerciseEveryCwdCarryingOperation(CodexSDKBridge bridge, String cwd) {
        MessageCallback callback = new NoopCallback();
        // Starts the daemon first: a caller racing a start in progress is told the daemon is unavailable.
        bridge.preconnectCodex("channel", cwd, "root");
        bridge.sendMessage("channel", "question", "root", cwd, List.of(), "default", "test-model",
                "", null, null, callback, "message", new JsonObject());
        bridge.reviewCodex("channel", cwd, "root", callback);
        bridge.compactCodex("channel", cwd, "root", callback);
        bridge.releaseCodexThread("channel", cwd, "root");
        bridge.executeCodexPlan("channel", cwd, "root", "plan-item", "plan");
        bridge.readCodexNative("codex.listSkills", "channel", cwd, "root", new JsonObject());
        bridge.abortCodexTurn("channel", cwd);
        bridge.updateCodexSettings("channel", cwd, new JsonObject());
    }

    private static void awaitMethods(RecordingDaemon daemon, Set<String> methods) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 10_000L;
        while (!daemon.cwdByMethod.keySet().containsAll(methods) && System.currentTimeMillis() < deadline) {
            Thread.sleep(20L);
        }
    }

    private static final class RecordingDaemon extends DaemonBridge {
        private final Map<String, String> cwdByMethod = new ConcurrentHashMap<>();
        private final String launchedNode;
        private final String wslDistro;

        private RecordingDaemon(String launchedNode, String wslDistro) {
            super(null, null, null);
            this.launchedNode = launchedNode;
            this.wslDistro = wslDistro;
        }

        @Override
        public boolean start() {
            return true;
        }

        @Override
        public boolean isAlive() {
            return true;
        }

        @Override
        public void stop() {
        }

        @Override
        public String getLaunchedNodePath() {
            return this.launchedNode;
        }

        @Override
        public String getWslDistro() {
            return this.wslDistro;
        }

        @Override
        public CompletableFuture<Boolean> sendCommand(String method, JsonObject params,
                                                       DaemonOutputCallback callback) {
            if (params.has("cwd")) {
                this.cwdByMethod.put(method, params.get("cwd").getAsString());
            }
            return CompletableFuture.completedFuture(true);
        }
    }

    private static class NoopCallback implements MessageCallback {
        @Override
        public void onMessage(String type, String content) {
        }

        @Override
        public void onError(String error) {
        }

        @Override
        public void onComplete(SDKResult result) {
        }
    }

    private static final class FixtureSettings extends CodemossSettingsService {
        @Override
        public String getCodexRuntimeAccessMode() {
            return CODEX_RUNTIME_ACCESS_CLI_LOGIN;
        }

        @Override
        public JsonObject getActiveCodexProvider() {
            return new JsonObject();
        }
    }
}
