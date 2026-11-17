package com.github.claudecodegui.bridge;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public class EnvironmentConfiguratorClaudeConfigDirTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void nativeNodeChildReceivesTheConfiguredDirectory() throws Exception {
        Path dir = tmp.newFolder("profile").toPath();
        Map<String, String> env = new HashMap<>();
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, dir, false);
        assertEquals(dir.toString(), env.get("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void noOverrideLeavesTheEnvironmentUntouched() {
        Map<String, String> env = new HashMap<>();
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, null, false);
        assertFalse(env.containsKey("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void wslNodeDoesNotReceiveAWindowsPath() throws Exception {
        Path dir = tmp.newFolder("profile").toPath();
        Map<String, String> env = new HashMap<>();
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, dir, true);
        assertFalse(env.containsKey("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void overrideReplacesAnInheritedValue() throws Exception {
        Path dir = tmp.newFolder("profile").toPath();
        Map<String, String> env = new HashMap<>();
        env.put("CLAUDE_CONFIG_DIR", "stale");
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, dir, false);
        assertEquals(dir.toString(), env.get("CLAUDE_CONFIG_DIR"));
    }
}
