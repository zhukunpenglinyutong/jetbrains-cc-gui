package com.github.claudecodegui.cli.common;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CliErrorFormatterTest {

    @Test
    public void serviceUnavailableErrorIsWrappedWithRequestDetails() {
        String raw = "unexpected status 503 Service Unavailable: Service temporarily unavailable, "
                + "url: https://gongyiapi.mossx.ai/responses, "
                + "request id: a2400918-5ef5-4163-99b9-4a638f75708b";

        String formatted = CliErrorFormatter.formatExitError("Codex", 1, raw);

        assertTrue(formatted.contains("Codex CLI 请求失败"));
        assertTrue(formatted.contains("服务暂时不可用 (503)"));
        assertTrue(formatted.contains("https://gongyiapi.mossx.ai/responses"));
        assertTrue(formatted.contains("a2400918-5ef5-4163-99b9-4a638f75708b"));
        assertTrue(formatted.contains("Codex CLI exited with code: 1"));
    }

    @Test
    public void rawExitNoiseIsCollapsedWhenFormattingDiagnostics() {
        String raw = "unexpected status 504 Gateway Timeout: upstream timeout\n"
                + "Codex CLI exited with code: 1\n"
                + "unexpected status 504 Gateway Timeout: upstream timeout";

        String formatted = CliErrorFormatter.formatExitError("Codex", 1, raw);

        assertTrue(formatted.contains("网关或上游服务超时 (504)"));
        assertTrue(formatted.contains("Codex CLI exited with code: 1"));
        assertFalse(formatted.contains("Codex CLI exited with code: 1\nCodex CLI exited with code: 1"));
    }
}
