package com.github.claudecodegui.provider.codex;

import org.junit.Test;

import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

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
    }
}
