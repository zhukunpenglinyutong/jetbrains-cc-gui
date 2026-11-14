package com.github.claudecodegui.cli;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

public class CliStatusDetectorCodexWslTest {
    private static final List<String> COMMAND = List.of("wsl", "/usr/bin/node", "/mnt/c/ai-bridge/probe.js");

    @Test
    public void reportsCodexInstalledInWslWhenItRunsThereAndIsNotOnTheWindowsSide() {
        List<List<String>> commands = new ArrayList<>();
        CliToolStatus status = CliStatusDetector.detectCodexInWsl(COMMAND, command -> {
            commands.add(command);
            return "/home/user/.local/bin/codex\ncodex-cli 0.5.1";
        });

        assertTrue(status.isInstalled());
        assertEquals(CliToolId.CODEX.getId(), status.getId());
        assertEquals("0.5.1", status.getVersion());
        assertEquals("/home/user/.local/bin/codex", status.getPath());
        assertEquals(List.of(COMMAND), commands);
    }

    @Test
    public void fallsThroughWhenWslHasNoWorkingCodex() {
        assertNull(CliStatusDetector.detectCodexInWsl(COMMAND, command -> null));
        assertNull(CliStatusDetector.detectCodexInWsl(COMMAND, command -> ""));
        assertNull(CliStatusDetector.detectCodexInWsl(COMMAND, command -> "/home/user/.local/bin/codex\nnot a version"));
    }

    @Test
    public void ignoresShellNoiseAroundTheProbeOutput() {
        CliToolStatus status = CliStatusDetector.detectCodexInWsl(COMMAND, command ->
                "wsl: some warning\n/usr/local/bin/codex\ncodex-cli 1.2.3-beta.1\n");

        assertTrue(status.isInstalled());
        assertEquals("1.2.3-beta.1", status.getVersion());
        assertEquals("/usr/local/bin/codex", status.getPath());
        assertFalse(status.getPath().startsWith("wsl"));
    }

    /** Starts the probe the way the daemon starts, so a working chat implies a working probe. */
    @Test
    public void probesWithTheBridgeScriptAndTheConfiguredNode() {
        File bridgeDir = new File("ai-bridge").getAbsoluteFile();
        List<String> command = CliStatusDetector.codexWslProbeCommand("/usr/bin/node", bridgeDir);

        File script = new File(bridgeDir, "services/codex/codex-cli-probe.js");
        assertTrue("probe script must ship with the bridge: " + script, script.isFile());
        assertEquals(NodeDetector.buildNodeScriptCommand("/usr/bin/node", script.getAbsolutePath()), command);
    }

    /** Runs the whole path through the real wsl.exe; only the Windows CI job gets past the assumptions. */
    @Test
    public void detectsCodexThroughRealWsl() throws Exception {
        assumeTrue("Skipped: not running on Windows", PlatformUtils.isWindows());
        String node = wsl("command -v node", null);
        assumeTrue("Skipped: WSL or its node is not available", node != null && node.startsWith("/"));

        boolean ownsFakeCodex = wsl("test -e ~/.local/bin/codex", null) == null;
        if (ownsFakeCodex) {
            assertNotNull(wsl("mkdir -p ~/.local/bin && cat > ~/.local/bin/codex && chmod +x ~/.local/bin/codex",
                    "#!/bin/sh\necho codex-cli 9.9.9\n"));
        }
        try {
            CliToolStatus status = CliStatusDetector.detectCodexInWsl(node, new File("ai-bridge").getAbsoluteFile());

            assertNotNull("the probe must report Codex through wsl.exe", status);
            assertTrue(status.isInstalled());
            assertTrue(status.getPath(), status.getPath().startsWith("/") && status.getPath().endsWith("/codex"));
            if (ownsFakeCodex) {
                assertEquals("9.9.9", status.getVersion());
            }
        } finally {
            if (ownsFakeCodex) {
                wsl("rm -f ~/.local/bin/codex", null);
            }
        }
    }

    /** Returns the trimmed stdout of a script run inside WSL, or null when it fails. */
    private static String wsl(String script, String stdin) throws Exception {
        Process process;
        try {
            process = new ProcessBuilder("wsl", "-e", "sh", "-c", script)
                    .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        } catch (IOException e) {
            return null;
        }
        try (OutputStream input = process.getOutputStream()) {
            if (stdin != null) {
                input.write(stdin.getBytes(StandardCharsets.UTF_8));
            }
        }
        if (!process.waitFor(60, TimeUnit.SECONDS)) {
            process.destroyForcibly();
            return null;
        }
        String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        return process.exitValue() == 0 ? output : null;
    }
}
