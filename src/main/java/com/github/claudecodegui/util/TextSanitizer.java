package com.github.claudecodegui.util;

import org.jetbrains.annotations.Nullable;

/**
 * Utility methods for sanitizing and truncating text safely for persistence.
 */
public final class TextSanitizer {

    private TextSanitizer() {
    }

    /**
     * Replaces invalid surrogate characters with the replacement character.
     */
    @Nullable
    public static String sanitizeInvalidSurrogates(@Nullable String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        StringBuilder builder = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char currentChar = text.charAt(i);
            if (Character.isHighSurrogate(currentChar)) {
                if (i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                    builder.append(currentChar).append(text.charAt(i + 1));
                    i++;
                } else {
                    builder.append('\uFFFD');
                }
            } else if (Character.isLowSurrogate(currentChar)) {
                builder.append('\uFFFD');
            } else {
                builder.append(currentChar);
            }
        }
        return builder.toString();
    }

    /**
     * Sanitizes text, flattens line breaks, trims it, and truncates by Unicode code points.
     */
    @Nullable
    public static String sanitizeAndTruncateSingleLine(@Nullable String text, int maxCodePoints) {
        String sanitized = sanitizeInvalidSurrogates(text);
        if (sanitized == null) {
            return null;
        }
        sanitized = sanitized
                .replace("\r\n", " ")
                .replace('\r', ' ')
                .replace('\n', ' ')
                .trim();
        if (sanitized.isEmpty()) {
            return null;
        }
        int codePointCount = sanitized.codePointCount(0, sanitized.length());
        if (codePointCount > maxCodePoints) {
            int endIndex = sanitized.offsetByCodePoints(0, maxCodePoints);
            return sanitized.substring(0, endIndex) + "...";
        }
        return sanitized;
    }
}
