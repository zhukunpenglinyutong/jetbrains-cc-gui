package com.github.claudecodegui.cli;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class CliStatusDetectorCodexWslTest {
    @Test
    public void reportsCodexInstalledInWslWhenItRunsThereAndIsNotOnTheWindowsSide() {
        List<List<String>> commands = new ArrayList<>();
        CliToolStatus status = CliStatusDetector.detectCodexInWsl(command -> {
            commands.add(command);
            return "/home/user/.local/bin/codex\ncodex-cli 0.5.1";
        });

        assertTrue(status.isInstalled());
        assertEquals(CliToolId.CODEX.getId(), status.getId());
        assertEquals("0.5.1", status.getVersion());
        assertEquals("/home/user/.local/bin/codex", status.getPath());
        assertEquals(1, commands.size());
        assertEquals("wsl", commands.get(0).get(0));
    }

    @Test
    public void fallsThroughWhenWslHasNoWorkingCodex() {
        assertNull(CliStatusDetector.detectCodexInWsl(command -> null));
        assertNull(CliStatusDetector.detectCodexInWsl(command -> ""));
        assertNull(CliStatusDetector.detectCodexInWsl(command -> "/home/user/.local/bin/codex\nnot a version"));
    }

    @Test
    public void ignoresShellNoiseAroundTheProbeOutput() {
        CliToolStatus status = CliStatusDetector.detectCodexInWsl(command ->
                "wsl: some warning\n/usr/local/bin/codex\ncodex-cli 1.2.3-beta.1\n");

        assertTrue(status.isInstalled());
        assertEquals("1.2.3-beta.1", status.getVersion());
        assertEquals("/usr/local/bin/codex", status.getPath());
        assertFalse(status.getPath().startsWith("wsl"));
    }
}
