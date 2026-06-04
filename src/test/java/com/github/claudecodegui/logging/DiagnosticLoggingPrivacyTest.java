package com.github.claudecodegui.logging;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertFalse;

/**
 * Regression guard for M1: diagnostic logs that include prompt/attachment
 * metadata must stay out of IDEA's default INFO/WARN log stream.
 */
public class DiagnosticLoggingPrivacyTest {

    private static final List<String> SENSITIVE_DIAGNOSTIC_FILES = List.of(
            "src/main/java/com/github/claudecodegui/session/ClaudeSession.java",
            "src/main/java/com/github/claudecodegui/handler/SessionHandler.java",
            "src/main/java/com/github/claudecodegui/provider/claude/ClaudeSDKBridge.java",
            "src/main/java/com/github/claudecodegui/cli/common/CliAttachmentHandler.java",
            "src/main/java/com/github/claudecodegui/cli/claude/ClaudeCliSession.java"
    );

    @Test
    public void diagnosticLogsDoNotUseInfoOrWarnLevel() throws Exception {
        for (String file : SENSITIVE_DIAGNOSTIC_FILES) {
            String source = Files.readString(Path.of(file), StandardCharsets.UTF_8);
            List<String> lines = source.lines().toList();

            assertFalse(file + " must not emit DIAG logs at INFO",
                    lines.stream().anyMatch(line -> line.contains("LOG.info(\"[") && line.contains("][DIAG]")));
            assertFalse(file + " must not emit DIAG logs at WARN",
                    lines.stream().anyMatch(line -> line.contains("LOG.warn(\"[") && line.contains("][DIAG]")));
            assertFalse(file + " must not emit ClaudeImageDiag logs at INFO",
                    lines.stream().anyMatch(line -> line.contains("LOG.info(\"[ClaudeImageDiag]")));
            assertFalse(file + " must not emit ClaudeImageDiag logs at WARN",
                    lines.stream().anyMatch(line -> line.contains("LOG.warn(\"[ClaudeImageDiag]")));
        }
    }
}
