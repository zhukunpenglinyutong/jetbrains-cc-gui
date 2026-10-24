package com.github.claudecodegui.settings;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class AiDataExternalProcessDetectorTest {

    @Test
    public void recognizesCliExecutableAndNodeEntrypoints() {
        assertTrue(AiDataExternalProcessDetector.looksLikeManagedCli("C:\\bin\\claude.exe", new String[0]));
        assertTrue(AiDataExternalProcessDetector.looksLikeManagedCli("codex.exe", new String[0]));
        assertTrue(AiDataExternalProcessDetector.looksLikeManagedCli("node.exe",
                new String[]{"C:\\tools\\@anthropic-ai\\claude-code\\cli.js"}));
        assertTrue(AiDataExternalProcessDetector.looksLikeManagedCli("node",
                new String[]{"/usr/local/lib/node_modules/@openai/codex/bin/codex.js"}));
    }

    @Test
    public void ignoresUnrelatedApplicationsAndPluginClasspath() {
        assertFalse(AiDataExternalProcessDetector.looksLikeManagedCli("idea64.exe",
                new String[]{"-classpath", "C:\\plugins\\codex\\plugin.jar"}));
        assertFalse(AiDataExternalProcessDetector.looksLikeManagedCli("node.exe",
                new String[]{"C:\\project\\codex-helper.js"}));
        assertFalse(AiDataExternalProcessDetector.looksLikeManagedCli("clause.exe", new String[0]));
    }
}
