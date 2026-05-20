package com.github.claudecodegui.provider.claude;

import org.junit.Test;

import static org.junit.Assert.assertTrue;

public class ClaudeCliBridgeDiagnosticsTest {

    @Test
    public void includesCliOutputInNonZeroExitError() {
        StringBuilder diagnostic = new StringBuilder();
        ClaudeCliBridge.appendCliDiagnosticLine(diagnostic, "Authentication failed");
        ClaudeCliBridge.appendCliDiagnosticLine(diagnostic, "Run claude auth login");

        String error = ClaudeCliBridge.buildCliExitError(1, diagnostic);

        assertTrue(error.contains("CLI process exited with code: 1"));
        assertTrue(error.contains("Details:"));
        assertTrue(error.contains("Authentication failed"));
        assertTrue(error.contains("Run claude auth login"));
    }
}
