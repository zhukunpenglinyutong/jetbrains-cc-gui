package com.github.claudecodegui.provider.claude;

import java.util.regex.Pattern;

/**
 * Sanitizes Claude bridge payloads before they are written to logs.
 */
class ClaudeLogSanitizer {

    // The {8,} quantifier intentionally skips values shorter than 8 characters
    // to avoid false positives on short field values that happen to match key names.
    private static final Pattern SENSITIVE_DATA_PATTERN = Pattern.compile(
            "(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|"
                    + "authorization|bearer|credential|credentials|private[_-]?key|access[_-]?key)"
                    + "[\"']?\\s*[:=]\\s*[\"']?[^\"'\\s,}]{8,}",
            Pattern.CASE_INSENSITIVE
    );

    String sanitizeSensitiveData(String json) {
        if (json == null || json.isEmpty()) {
            return json;
        }
        return SENSITIVE_DATA_PATTERN.matcher(json).replaceAll("$1: [REDACTED]");
    }

    String buildPreview(String json, int maxChars) {
        String sanitized = sanitizeSensitiveData(json);
        if (sanitized == null || sanitized.length() <= maxChars) {
            return sanitized;
        }
        return sanitized.substring(0, maxChars)
                + "\n... (truncated, total: " + json.length() + " chars)";
    }
}
