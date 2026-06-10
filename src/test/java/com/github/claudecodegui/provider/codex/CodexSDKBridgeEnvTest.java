package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import org.junit.Test;

import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodexSDKBridgeEnvTest {

    @Test
    public void configureProviderEnvDoesNotInjectUseStdinFlag() throws Exception {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-env");
        try {
            TestCodexSDKBridge bridge = new TestCodexSDKBridge(sessionsDir);
            Map<String, String> env = new LinkedHashMap<>();

            bridge.applyProviderEnv(env, "{}");

            assertFalse(env.containsKey("CODEX_USE_STDIN"));
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void populateCodexRuntimeEnvDoesNotInjectUseStdinFlag() throws Exception {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-runtime-env");
        try {
            CodexSDKBridge bridge = new CodexSDKBridge(sessionsDir);
            Map<String, String> env = new LinkedHashMap<>();

            Method method = CodexSDKBridge.class.getDeclaredMethod(
                    "populateCodexRuntimeEnv",
                    Map.class,
                    String.class,
                    String.class,
                    String.class,
                    String.class
            );
            method.setAccessible(true);
            method.invoke(bridge, env, "/workspace", "default", "codex-mini", "message");

            assertFalse(env.containsKey("CODEX_USE_STDIN"));
            assertTrue(env.containsKey("CODEX_MODEL"));
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void populateCodexRuntimeEnvMapsPlanToReadOnlySuggestMode() throws Exception {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-plan-env");
        try {
            CodexSDKBridge bridge = new CodexSDKBridge(sessionsDir);
            Map<String, String> env = populateRuntimeEnv(bridge, "plan");

            assertEquals("read-only", env.get("CODEX_SANDBOX_MODE"));
            assertEquals("read-only", env.get("CODEX_SANDBOX"));
            assertEquals("untrusted", env.get("CODEX_APPROVAL_POLICY"));
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void populateCodexRuntimeEnvMapsBypassToNeverFullAccessMode() throws Exception {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-bypass-env");
        try {
            CodexSDKBridge bridge = new CodexSDKBridge(sessionsDir);
            Map<String, String> env = populateRuntimeEnv(bridge, "bypassPermissions");

            assertEquals("danger-full-access", env.get("CODEX_SANDBOX_MODE"));
            assertEquals("danger-full-access", env.get("CODEX_SANDBOX"));
            assertEquals("never", env.get("CODEX_APPROVAL_POLICY"));
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    @Test
    public void processOutputLineIgnoresCodexStatusMessages() throws Exception {
        Path sessionsDir = Files.createTempDirectory("codex-sdk-bridge-status");
        try {
            TestCodexSDKBridge bridge = new TestCodexSDKBridge(sessionsDir);
            RecordingCallback callback = new RecordingCallback();
            SDKResult result = new SDKResult();

            bridge.processLine(
                    "[MESSAGE] {\"type\":\"status\",\"message\":\"正在执行命令: git status\"}",
                    callback,
                    result
            );

            assertFalse(callback.events.stream().anyMatch(event -> "status".equals(event.type)));
            assertTrue(result.messages.isEmpty());
        } finally {
            deleteDirectory(sessionsDir);
        }
    }

    private static Map<String, String> populateRuntimeEnv(CodexSDKBridge bridge, String permissionMode) throws Exception {
        Map<String, String> env = new LinkedHashMap<>();
        Method method = CodexSDKBridge.class.getDeclaredMethod(
                "populateCodexRuntimeEnv",
                Map.class,
                String.class,
                String.class,
                String.class,
                String.class
        );
        method.setAccessible(true);
        method.invoke(bridge, env, "/workspace", permissionMode, "codex-mini", "message");
        return env;
    }

    private static void deleteDirectory(Path path) throws Exception {
        if (!Files.exists(path)) {
            return;
        }
        try (java.util.stream.Stream<Path> paths = Files.walk(path)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (Exception ignored) {
                }
            });
        }
    }

    private static class TestCodexSDKBridge extends CodexSDKBridge {
        TestCodexSDKBridge(Path sessionsDir) {
            super(sessionsDir);
        }

        void applyProviderEnv(Map<String, String> env, String stdinJson) {
            super.configureProviderEnv(env, stdinJson);
        }

        void processLine(String line, MessageCallback callback, SDKResult result) {
            super.processOutputLine(
                    line,
                    callback,
                    result,
                    new StringBuilder(),
                    new AtomicBoolean(false),
                    new AtomicReference<>()
            );
        }
    }

    private static final class RecordingCallback implements MessageCallback {
        private final List<Event> events = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
            events.add(new Event(type, content));
        }

        @Override
        public void onError(String error) {
        }

        @Override
        public void onComplete(SDKResult result) {
        }
    }

    private record Event(String type, String content) {
    }
}
