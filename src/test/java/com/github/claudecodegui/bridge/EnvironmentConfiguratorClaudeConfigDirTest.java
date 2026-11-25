package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class EnvironmentConfiguratorClaudeConfigDirTest {

    private static final String UNC = "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude-work";

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
    public void noOverrideRemovesAnInheritedValueTheResolverRejected() {
        Map<String, String> env = new HashMap<>();
        env.put("CLAUDE_CONFIG_DIR", "relative/profile");
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, null, false);
        assertFalse(env.containsKey("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void wslNodeReceivesTheLinuxSpellingOfAUncDirectory() {
        Map<String, String> env = new HashMap<>();
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, Paths.get(UNC), true);
        assertEquals("/home/me/.claude-work", env.get("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void wslNodeReceivesMountPathForAWindowsDriveDirectory() {
        Map<String, String> env = new HashMap<>();
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, Paths.get("D:\\profiles\\work"), true);
        assertEquals("/mnt/d/profiles/work", env.get("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void wslNodeNeverInheritsARawWindowsValue() {
        Map<String, String> env = new HashMap<>();
        env.put("CLAUDE_CONFIG_DIR", "D:\\inherited");
        EnvironmentConfigurator.configureClaudeConfigDirEnv(env, null, true);
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

    @Test
    public void wslEnvListCarriesTheConfigDirAcrossTheBoundary() {
        Assume.assumeTrue("WSL path translation is only meaningful on Windows", PlatformUtils.isWindows());
        Map<String, String> env = new HashMap<>();
        new EnvironmentConfigurator().configurePermissionEnv(env, "/usr/bin/node");
        assertTrue(env.get("WSLENV"), env.get("WSLENV").contains("CLAUDE_CONFIG_DIR"));
    }
}
