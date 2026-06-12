package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Assume;
import org.junit.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class EnvironmentConfiguratorPermissionTimeoutTest {

    @Test
    public void configurePermissionEnvPassesEffectiveSafetyNetTimeoutToNode() {
        EnvironmentConfigurator configurator = new EnvironmentConfigurator(new FakeSettingsService(120));
        Map<String, String> env = new HashMap<>();

        configurator.configurePermissionEnv(env);

        assertEquals("180000", env.get("CLAUDE_PERMISSION_SAFETY_NET_MS"));
        assertTrue(env.containsKey("CLAUDE_PERMISSION_DIR"));
        assertTrue(env.containsKey("CLAUDE_SESSION_ID"));
    }

    // =========================================================================
    // Regression: WSL Node binaries must receive a Linux-readable IPC dir
    // =========================================================================

    @Test
    public void translatePermissionDirForNode_nullDir_returnsNull() {
        assertNull(EnvironmentConfigurator.translatePermissionDirForNode(null, "/usr/bin/node"));
    }

    @Test
    public void translatePermissionDirForNode_emptyDir_returnsEmpty() {
        assertEquals("", EnvironmentConfigurator.translatePermissionDirForNode("", "/usr/bin/node"));
    }

    @Test
    public void translatePermissionDirForNode_nullNode_returnsDirVerbatim() {
        String dir = "C:\\Users\\foo\\AppData\\Local\\Temp\\claude-permission";
        assertEquals(dir, EnvironmentConfigurator.translatePermissionDirForNode(dir, null));
    }

    @Test
    public void translatePermissionDirForNode_windowsNode_returnsDirVerbatim() {
        String dir = "C:\\Users\\foo\\AppData\\Local\\Temp\\claude-permission";
        assertEquals(dir,
                EnvironmentConfigurator.translatePermissionDirForNode(dir, "C:\\Program Files\\nodejs\\node.exe"));
    }

    @Test
    public void translatePermissionDirForNode_wslNodeOnWindows_convertsToMntPath() {
        Assume.assumeTrue("WSL path translation is only meaningful on Windows", PlatformUtils.isWindows());

        String dir = "C:\\Users\\foo\\AppData\\Local\\Temp\\claude-permission";
        String translated = EnvironmentConfigurator.translatePermissionDirForNode(dir, "/usr/bin/node");

        assertNotNull(translated);
        assertEquals("/mnt/c/Users/foo/AppData/Local/Temp/claude-permission", translated);
    }

    @Test
    public void configurePermissionEnvUsesWslDirWhenNodeIsWsl() {
        Assume.assumeTrue("WSL path translation is only meaningful on Windows", PlatformUtils.isWindows());

        EnvironmentConfigurator configurator = new EnvironmentConfigurator(new FakeSettingsService(60));
        Map<String, String> env = new HashMap<>();

        configurator.configurePermissionEnv(env, "/usr/bin/node");

        String dir = env.get("CLAUDE_PERMISSION_DIR");
        assertNotNull(dir);
        assertTrue("WSL node should receive a /mnt/-style permission dir, got: " + dir,
                dir.startsWith("/mnt/") || dir.startsWith("/"));
    }

    @Test
    public void configurePermissionEnvSetsWslenvWhenNodeIsWsl() {
        Assume.assumeTrue("WSLENV propagation is only meaningful on Windows", PlatformUtils.isWindows());

        EnvironmentConfigurator configurator = new EnvironmentConfigurator(new FakeSettingsService(60));
        Map<String, String> env = new HashMap<>();

        configurator.configurePermissionEnv(env, "/usr/bin/node");

        String wslenv = env.get("WSLENV");
        assertNotNull("WSLENV must be set when node is a WSL binary", wslenv);
        assertTrue("WSLENV must include CLAUDE_PERMISSION_DIR", wslenv.contains("CLAUDE_PERMISSION_DIR"));
        assertTrue("WSLENV must include CLAUDE_SESSION_ID", wslenv.contains("CLAUDE_SESSION_ID"));
        assertTrue("WSLENV must include CLAUDE_PERMISSION_SAFETY_NET_MS", wslenv.contains("CLAUDE_PERMISSION_SAFETY_NET_MS"));
    }

    @Test
    public void configurePermissionEnvDoesNotSetWslenvForWindowsNode() {
        EnvironmentConfigurator configurator = new EnvironmentConfigurator(new FakeSettingsService(60));
        Map<String, String> env = new HashMap<>();

        configurator.configurePermissionEnv(env, "C:\\Program Files\\nodejs\\node.exe");

        assertNull("WSLENV must not be set for a native Windows node", env.get("WSLENV"));
    }

    private static class FakeSettingsService extends CodemossSettingsService {
        private final int timeoutSeconds;

        private FakeSettingsService(int timeoutSeconds) {
            this.timeoutSeconds = timeoutSeconds;
        }

        @Override
        public int getPermissionDialogTimeoutSeconds() throws IOException {
            return timeoutSeconds;
        }
    }
}
