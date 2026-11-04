package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

public class CodexSDKBridgeWslCwdTest {
    private static final String LINUX_CWD = "/home/user/project";

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
        NodeDetector.getInstance().setNodeExecutable("/usr/bin/node");
        for (String uncCwd : new String[]{"//wsl.localhost/Ubuntu/home/user/project",
                "\\\\wsl.localhost\\Ubuntu\\home\\user\\project",
                "\\\\wsl$\\Ubuntu\\home\\user\\project"}) {
            RecordingDaemon daemon = new RecordingDaemon();
            CodexSDKBridge bridge = newBridge(daemon);
            try {
                exerciseEveryCwdCarryingOperation(bridge, uncCwd);
                for (Map.Entry<String, String> sent : daemon.cwdByMethod.entrySet()) {
                    assertEquals(sent.getKey() + " for " + uncCwd, LINUX_CWD, sent.getValue());
                }
                assertTrue("operations reached the daemon: " + daemon.cwdByMethod.keySet(),
                        daemon.cwdByMethod.size() >= 4);
            } finally {
                bridge.cleanupAllProcesses();
            }
        }
    }

    @Test
    public void keepsCwdUnchangedWhenNodeIsNative() throws Exception {
        NodeDetector.getInstance().setNodeExecutable("C:\\Program Files\\nodejs\\node.exe");
        String cwd = "C:\\work\\project";
        RecordingDaemon daemon = new RecordingDaemon();
        CodexSDKBridge bridge = newBridge(daemon);
        try {
            exerciseEveryCwdCarryingOperation(bridge, cwd);
            for (Map.Entry<String, String> sent : daemon.cwdByMethod.entrySet()) {
                assertEquals(sent.getKey(), cwd, sent.getValue());
            }
        } finally {
            bridge.cleanupAllProcesses();
        }
    }

    private CodexSDKBridge newBridge(RecordingDaemon daemon) {
        String scope = this.folder.getRoot().getAbsolutePath() + daemon.hashCode();
        return new CodexSDKBridge(this.folder.getRoot().toPath(), new FixtureSettings(), () -> daemon, scope);
    }

    private static void exerciseEveryCwdCarryingOperation(CodexSDKBridge bridge, String cwd) throws Exception {
        MessageCallback callback = new NoopCallback();
        bridge.sendMessage("channel", "question", "root", cwd, List.of(), "default", "test-model",
                "", null, null, callback, "message", new JsonObject());
        bridge.reviewCodex("channel", cwd, "root", callback);
        bridge.compactCodex("channel", cwd, "root", callback);
        bridge.preconnectCodex("channel", cwd, "root");
        bridge.releaseCodexThread("channel", cwd, "root");
        bridge.executeCodexPlan("channel", cwd, "root", "plan-item", "plan");
        Thread.sleep(500);
    }

    private static final class RecordingDaemon extends DaemonBridge {
        private final Map<String, String> cwdByMethod = new ConcurrentHashMap<>();

        private RecordingDaemon() {
            super(null, null, null);
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
        public CompletableFuture<Boolean> sendCommand(String method, JsonObject params,
                                                       DaemonOutputCallback callback) {
            if (params.has("cwd")) {
                this.cwdByMethod.put(method, params.get("cwd").getAsString());
            }
            return CompletableFuture.completedFuture(true);
        }
    }

    private static final class NoopCallback implements MessageCallback {
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
