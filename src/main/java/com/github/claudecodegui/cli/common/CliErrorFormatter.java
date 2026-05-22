package com.github.claudecodegui.cli.common;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Formats raw CLI process failures into a single user-facing error message.
 */
public final class CliErrorFormatter {
    private static final int DEFAULT_MAX_CHARS = 4000;
    private static final Pattern STATUS_PATTERN = Pattern.compile("(?i)\\b(?:unexpected status\\s+)?([45]\\d{2})\\b");
    private static final Pattern URL_PATTERN = Pattern.compile("(?i)\\burl:\\s*(\\S+)");
    private static final Pattern REQUEST_ID_PATTERN = Pattern.compile("(?i)\\brequest id:\\s*([\\w.-]+)");

    private CliErrorFormatter() {
    }

    public static String formatExitError(String provider, int exitCode, CharSequence diagnostic) {
        String providerName = normalizeProvider(provider);
        String details = normalizeDiagnostic(diagnostic);
        StringBuilder message = new StringBuilder();
        message.append(providerName).append(" CLI 请求失败\n");
        message.append("原因: ").append(summarize(details)).append('\n');
        message.append("退出码: ").append(providerName).append(" CLI exited with code: ").append(exitCode);
        appendMetadata(message, details);
        appendDetails(message, details);
        return message.toString();
    }

    public static String formatError(String provider, String rawError) {
        String providerName = normalizeProvider(provider);
        String details = normalizeDiagnostic(rawError);
        StringBuilder message = new StringBuilder();
        message.append(providerName).append(" CLI 请求失败\n");
        message.append("原因: ").append(summarize(details));
        appendMetadata(message, details);
        appendDetails(message, details);
        return message.toString();
    }

    public static void appendDiagnosticLine(StringBuilder diagnostic, String line) {
        appendDiagnosticLine(diagnostic, line, DEFAULT_MAX_CHARS);
    }

    public static void appendDiagnosticLine(StringBuilder diagnostic, String line, int maxChars) {
        if (diagnostic == null || line == null || line.isBlank()) {
            return;
        }
        if (diagnostic.length() > 0) {
            diagnostic.append('\n');
        }
        diagnostic.append(line.trim());
        int overflow = diagnostic.length() - Math.max(1, maxChars);
        if (overflow > 0) {
            diagnostic.delete(0, overflow);
        }
    }

    private static String normalizeProvider(String provider) {
        if (provider == null || provider.isBlank()) {
            return "AI";
        }
        String trimmed = provider.trim();
        return trimmed.substring(0, 1).toUpperCase() + trimmed.substring(1);
    }

    private static String summarize(String details) {
        if (details == null || details.isBlank()) {
            return "CLI 进程异常退出";
        }
        Integer status = extractStatus(details);
        if (status != null) {
            return switch (status) {
                case 429 -> "请求过于频繁 (429)";
                case 500 -> "上游服务内部错误 (500)";
                case 502 -> "网关或上游服务异常 (502)";
                case 503 -> "服务暂时不可用 (503)";
                case 504 -> "网关或上游服务超时 (504)";
                default -> status >= 500 ? "上游服务错误 (" + status + ")" : "请求失败 (" + status + ")";
            };
        }
        String lower = details.toLowerCase();
        if (lower.contains("timeout") || lower.contains("timed out")) {
            return "请求超时";
        }
        if (lower.contains("unauthorized") || lower.contains("authentication") || lower.contains("auth failed")) {
            return "认证失败";
        }
        if (lower.contains("rate limit") || lower.contains("quota")) {
            return "请求频率或额度受限";
        }
        if (lower.contains("network") || lower.contains("connection") || lower.contains("dns")) {
            return "网络连接异常";
        }
        return firstLine(details);
    }

    private static Integer extractStatus(String details) {
        Matcher matcher = STATUS_PATTERN.matcher(details);
        if (!matcher.find()) {
            return null;
        }
        try {
            return Integer.parseInt(matcher.group(1));
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static void appendMetadata(StringBuilder message, String details) {
        String url = extractFirst(URL_PATTERN, details);
        if (url != null) {
            message.append('\n').append("URL: ").append(stripTrailingPunctuation(url));
        }
        String requestId = extractFirst(REQUEST_ID_PATTERN, details);
        if (requestId != null) {
            message.append('\n').append("Request ID: ").append(stripTrailingPunctuation(requestId));
        }
    }

    private static void appendDetails(StringBuilder message, String details) {
        if (details == null || details.isBlank()) {
            return;
        }
        message.append("\n\nDetails:\n").append(details);
    }

    private static String extractFirst(Pattern pattern, String details) {
        if (details == null) {
            return null;
        }
        Matcher matcher = pattern.matcher(details);
        return matcher.find() ? matcher.group(1) : null;
    }

    private static String normalizeDiagnostic(CharSequence diagnostic) {
        if (diagnostic == null) {
            return "";
        }
        String raw = diagnostic.toString().trim();
        if (raw.isEmpty()) {
            return "";
        }
        String[] lines = raw.split("\\R");
        Set<String> unique = new LinkedHashSet<>();
        for (String line : lines) {
            String trimmed = line == null ? "" : line.trim();
            if (!trimmed.isEmpty()) {
                unique.add(trimmed);
            }
        }
        return String.join("\n", unique);
    }

    private static String firstLine(String details) {
        int idx = details.indexOf('\n');
        String line = idx >= 0 ? details.substring(0, idx) : details;
        return line.length() > 160 ? line.substring(0, 160) + "..." : line;
    }

    private static String stripTrailingPunctuation(String value) {
        if (value == null) {
            return null;
        }
        return value.replaceFirst("[,;。]+$", "");
    }
}
