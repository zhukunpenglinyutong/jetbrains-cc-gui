package com.github.claudecodegui.cli;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class CliSessionManagerTest {

    @Test
    public void interruptProviderRoutesOnlyCodexToCodexRuntime() {
        assertEquals("codex", CliSessionManager.normalizeInterruptProvider("codex"));
        assertEquals("claude", CliSessionManager.normalizeInterruptProvider("claude"));
        assertEquals("claude", CliSessionManager.normalizeInterruptProvider("custom-claude-compatible"));
        assertEquals("claude", CliSessionManager.normalizeInterruptProvider(null));
    }
}
