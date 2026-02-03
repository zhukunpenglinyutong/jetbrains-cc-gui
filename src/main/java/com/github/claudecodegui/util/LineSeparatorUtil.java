package com.github.claudecodegui.util;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Utility class for handling line separator normalization.
 * <p>
 * Provides methods to normalize line separators (CRLF, LF, CR) in text content.
 * This is essential for:
 * <ul>
 *   <li>Diff view comparison - prevents every line showing as changed when line separators differ</li>
 *   <li>Content matching - ensures string matching works across different OS line endings</li>
 *   <li>IntelliJ Document compatibility - IntelliJ internally uses LF</li>
 * </ul>
 * <p>
 * Line separator types:
 * <ul>
 *   <li>CRLF (\r\n) - Windows</li>
 *   <li>LF (\n) - Unix/Linux/macOS</li>
 *   <li>CR (\r) - Classic Mac OS (rare)</li>
 * </ul>
 */
public final class LineSeparatorUtil {

    /** Unix/Linux/macOS line separator */
    public static final String LF = "\n";

    /** Windows line separator */
    public static final String CRLF = "\r\n";

    private LineSeparatorUtil() {
    }

    /**
     * Normalize all line separators in the content to the specified separator.
     * <p>
     * This method handles mixed line separators (e.g., content with both CRLF and LF)
     * by first converting everything to LF, then to the target separator.
     *
     * @param content       the content to normalize (may be null or empty)
     * @param lineSeparator the target line separator (e.g., "\n" or "\r\n")
     * @return the normalized content, or the original if null/empty
     */
    @NotNull
    public static String normalizeToSeparator(@Nullable String content, @NotNull String lineSeparator) {
        if (content == null || content.isEmpty()) {
            return content == null ? "" : content;
        }

        // First, normalize all line separators to LF
        // This handles mixed line separators (e.g., \r\n and \n mixed)
        String normalized = content
                .replace("\r\n", "\n")  // Windows -> Unix
                .replace("\r", "\n");   // Old Mac -> Unix

        // If target is not LF, replace with target
        if (!LF.equals(lineSeparator)) {
            normalized = normalized.replace("\n", lineSeparator);
        }

        return normalized;
    }

    /**
     * Normalize line separators in target string to match the content's line separator style.
     * <p>
     * This is useful when you need to match/search for a string within content that may
     * use different line separators. The method detects the line separator style of the
     * content and converts the target to match.
     *
     * @param target  the string to normalize (may be null or empty)
     * @param content the content whose line separator style to match
     * @return the normalized string with matching line separators
     */
    @NotNull
    public static String normalizeToMatch(@Nullable String target, @NotNull String content) {
        if (target == null || target.isEmpty()) {
            return target == null ? "" : target;
        }

        // Detect line separator in content
        boolean hasCRLF = content.contains(CRLF);
        boolean hasLF = content.contains("\n") && !hasCRLF;

        if (hasCRLF) {
            // Content uses CRLF, convert target's LF to CRLF
            // First normalize to LF, then convert to CRLF
            return target.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\r\n");
        } else if (hasLF) {
            // Content uses LF, convert target's CRLF to LF
            return target.replace("\r\n", "\n").replace("\r", "\n");
        }

        // No line separators detected in content, return as-is
        return target;
    }

    /**
     * Normalize content to LF (Unix-style) line separators.
     * <p>
     * Convenience method equivalent to {@code normalizeToSeparator(content, LF)}.
     *
     * @param content the content to normalize
     * @return the normalized content with LF line separators
     */
    @NotNull
    public static String normalizeToLF(@Nullable String content) {
        return normalizeToSeparator(content, LF);
    }

    /**
     * Map position from normalized (LF) content to original content position.
     * <p>
     * When content is normalized to LF for processing, this method maps a position
     * in the normalized content back to the corresponding position in the original
     * content (which may use CRLF).
     *
     * @param original      the original content (may contain CRLF)
     * @param normalized    the normalized content (LF only)
     * @param normalizedPos the position in normalized content
     * @return the corresponding position in original content
     * @throws IllegalArgumentException if normalizedPos is negative
     */
    public static int mapToOriginalPosition(
            @NotNull String original,
            @NotNull String normalized,
            int normalizedPos
    ) {
        if (normalizedPos < 0) {
            throw new IllegalArgumentException("normalizedPos must be non-negative: " + normalizedPos);
        }

        // Clamp normalizedPos to valid range
        int clampedNormalizedPos = Math.min(normalizedPos, normalized.length());

        int originalPos = 0;
        int normalizedIdx = 0;

        while (normalizedIdx < clampedNormalizedPos && originalPos < original.length()) {
            if (original.charAt(originalPos) == '\r' &&
                originalPos + 1 < original.length() &&
                original.charAt(originalPos + 1) == '\n') {
                // CRLF in original, LF in normalized
                originalPos += 2;
                normalizedIdx += 1;
            } else if (original.charAt(originalPos) == '\r') {
                // CR in original, LF in normalized
                originalPos += 1;
                normalizedIdx += 1;
            } else {
                originalPos += 1;
                normalizedIdx += 1;
            }
        }

        return originalPos;
    }
}
