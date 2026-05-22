package com.github.claudecodegui.cli.claude;

import com.github.claudecodegui.cli.common.CliErrorFormatter;
import org.junit.Test;

import static org.junit.Assert.assertTrue;

public class ClaudeCliDiagnosticsTest {

    @Test
    public void includesCliOutputInNonZeroExitError() {
        StringBuilder diagnostic = new StringBuilder();
        CliErrorFormatter.appendDiagnosticLine(diagnostic, "Authentication failed");
        CliErrorFormatter.appendDiagnosticLine(diagnostic, "Run claude auth login");

        String error = CliErrorFormatter.formatExitError("Claude", 1, diagnostic);

        assertTrue(error.contains("Claude CLI 请求失败"));
        assertTrue(error.contains("Claude CLI exited with code: 1"));
        assertTrue(error.contains("Details:"));
        assertTrue(error.contains("Authentication failed"));
        assertTrue(error.contains("Run claude auth login"));
    }
}
