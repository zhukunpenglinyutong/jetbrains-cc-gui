package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.CodemossSettingsService;
import org.junit.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
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
