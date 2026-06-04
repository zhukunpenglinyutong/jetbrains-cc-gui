package com.github.claudecodegui.cli.common;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
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

    @Test
    public void diamondPrefixStrippedFromErrorOutput() {
        // CLI 输出中 ◇ 前缀应被剥离，不影响状态码检测
        String raw = "◇ exceeded retry limit, last status: 429 Too Many Requests, "
                + "request id: cde7e86f-f759-4b95-80b7-1578df4eab00";

        String formatted = CliErrorFormatter.formatExitError("Codex", 1, raw);

        assertTrue(formatted.contains("请求过于频繁 (429)"));
        assertTrue(formatted.contains("cde7e86f-f759-4b95-80b7-1578df4eab00"));
        assertFalse(formatted.contains("◇"));
    }

    @Test
    public void pureNoiseLinesAreFilteredFromDiagnostic() {
        // 纯 ◇ 噪声行应被过滤，不占环形缓冲区空间
        StringBuilder diagnostic = new StringBuilder();
        CliErrorFormatter.appendDiagnosticLine(diagnostic, "◇◇◇◇◇◇◇◇◇◇");
        CliErrorFormatter.appendDiagnosticLine(diagnostic, "◇◇◇");
        CliErrorFormatter.appendDiagnosticLine(diagnostic, "exceeded retry limit, last status: 429 Too Many Requests");

        String formatted = CliErrorFormatter.formatExitError("Codex", 1, diagnostic);

        assertTrue(formatted.contains("请求过于频繁 (429)"));
        assertFalse(formatted.contains("◇"));
    }

    @Test
    public void stripCliPrefixRemovesLeadingSymbols() {
        assertEquals("error message", CliErrorFormatter.stripCliPrefix("◇ error message"));
        assertEquals("error message", CliErrorFormatter.stripCliPrefix("  ◆  error message"));
        assertEquals("error", CliErrorFormatter.stripCliPrefix("✔ error"));
        assertEquals("", CliErrorFormatter.stripCliPrefix("◇◇◇"));
        assertEquals("normal text", CliErrorFormatter.stripCliPrefix("normal text"));
    }

    @Test
    public void isCliNoiseLineDetectsPureNoise() {
        assertTrue(CliErrorFormatter.isCliNoiseLine("◇◇◇◇◇◇◇◇◇◇"));
        assertTrue(CliErrorFormatter.isCliNoiseLine("  ◆◆◆  "));
        assertTrue(CliErrorFormatter.isCliNoiseLine(null));
        assertTrue(CliErrorFormatter.isCliNoiseLine(""));
        assertFalse(CliErrorFormatter.isCliNoiseLine("◇ error text"));
        assertFalse(CliErrorFormatter.isCliNoiseLine("normal output"));
    }

    @Test
    public void appendDiagnosticLineIgnoresNormalClaudeStreamJsonEvents() {
        StringBuilder diagnostic = new StringBuilder();
        CliErrorFormatter.appendDiagnosticLine(diagnostic,
                "{\"type\":\"system\",\"subtype\":\"thinking_tokens\",\"estimated_tokens\":23}");
        CliErrorFormatter.appendDiagnosticLine(diagnostic,
                "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\","
                        + "\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"模型。\"}}}");
        CliErrorFormatter.appendDiagnosticLine(diagnostic, "Authentication failed");

        assertEquals("Authentication failed", diagnostic.toString());
    }
}
