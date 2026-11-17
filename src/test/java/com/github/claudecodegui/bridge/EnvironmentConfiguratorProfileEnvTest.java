package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.ClaudeConfigDir;
import com.github.claudecodegui.util.PlatformUtils;
import org.junit.After;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class EnvironmentConfiguratorProfileEnvTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void restoreSettingReader() {
        ClaudeConfigDir.setSettingReaderForTests(null);
    }

    @Test
    public void everyNodeChildStartedThroughTheConfiguratorGetsTheStoredProfile() throws Exception {
        Path profile = tmp.newFolder("work-profile").toPath();
        ClaudeConfigDir.setSettingReaderForTests(() -> profile.toString());
        ProcessBuilder pb = new ProcessBuilder("node");
        pb.environment().remove("CLAUDE_CONFIG_DIR");

        new EnvironmentConfigurator().updateProcessEnvironment(pb, "node");

        assertEquals(profile.toString(), pb.environment().get("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void relativeStoredValueIsNotHandedToChildren() {
        Assume.assumeTrue("CLAUDE_CONFIG_DIR is set in this environment", System.getenv("CLAUDE_CONFIG_DIR") == null);
        ClaudeConfigDir.setSettingReaderForTests(() -> "work-profile");
        ProcessBuilder pb = new ProcessBuilder("node");
        pb.environment().remove("CLAUDE_CONFIG_DIR");

        new EnvironmentConfigurator().updateProcessEnvironment(pb, "node");

        assertFalse(pb.environment().containsKey("CLAUDE_CONFIG_DIR"));
    }

    @Test
    public void wslNodeGetsTheLinuxSpellingAndTheVariableCrossesTheBoundary() throws Exception {
        Assume.assumeTrue("WSL path translation is only meaningful on Windows", PlatformUtils.isWindows());
        Path profile = tmp.newFolder("work-profile").toPath();
        ClaudeConfigDir.setSettingReaderForTests(() -> profile.toString());
        ProcessBuilder pb = new ProcessBuilder("wsl");
        pb.environment().remove("CLAUDE_CONFIG_DIR");

        new EnvironmentConfigurator().updateProcessEnvironment(pb, "/usr/bin/node");

        String value = pb.environment().get("CLAUDE_CONFIG_DIR");
        assertTrue(value, value.startsWith("/mnt/"));
        assertTrue(pb.environment().get("WSLENV"), pb.environment().get("WSLENV").contains("CLAUDE_CONFIG_DIR"));
    }
}
