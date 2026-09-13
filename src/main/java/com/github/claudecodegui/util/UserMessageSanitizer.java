package com.github.claudecodegui.util;

import org.jetbrains.annotations.Nullable;

/**
 * Strips internal prompt/context additions from user-facing transcript text.
 * These sections are useful when sending to providers, but should not be
 * rendered back to users in history replay or tab restore flows.
 */
public final class UserMessageSanitizer {

    private static final String IMAGE_ATTACHMENT_HINT =
            "The user has attached the image(s) above. Please use the Read tool to view them.";

    private static final String[] SYSTEM_TAG_NAMES = {"agents-instructions", "system-reminder", "system-prompt", "skill"};

    private static final String[] APPENDED_CONTEXT_MARKERS = {
        "\n\n## Agent Role and Instructions\n\n",
        "\n\n## Workspace Context\n\n",
        "\n\n## Project Modules\n\nThis project contains multiple modules:\n",
        "\n\n## Active Terminal Session\n\nThe user is working in the following terminal context:\n\n",
        "\n\n## Referenced Files\n\nThe following files were referenced by the user:\n\n",
        "\n\n## IDE Context\n\n",
        "\n\n## User's Current IDE Context\n\nThe user is viewing this file in their IDE.",
        "\n\n## User's Current IDE Context\n\nThe user is working in an IDE.",
        "\n\n### Multi-Project Workspace Structure\n\n",
        "\n\n### Project Module Structure\n\nThis project contains multiple modules:\n"
    };

    private UserMessageSanitizer() {
    }

    /**
     * Removes system-only tags and appended prompt context from transcript text.
     */
    public static String sanitizeUserFacingText(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }

        String normalized = text.replace("\r\n", "\n").replace("\r", "\n");
        String strippedTags = stripSystemTags(normalized);
        String strippedImages = stripCodexImagePlaceholders(strippedTags);
        String strippedContext = stripAppendedContext(strippedImages);
        return strippedContext.trim();
    }

    /**
     * Normalizes transcript text for equality comparison across the two sources of the
     * same user message: the text built locally when the message is sent, and the text
     * the CLI persisted to the session JSONL. The two legitimately differ in line
     * separators, appended prompt context, system tags, image attachment hints and
     * incidental blank-line padding — none of which the user typed — so comparing the
     * raw strings misses matches that this normalization recovers.
     */
    public static String normalizeForComparison(@Nullable String text) {
        if (text == null) {
            return "";
        }
        String normalized = text.replace(IMAGE_ATTACHMENT_HINT, "");
        normalized = sanitizeUserFacingText(normalized);
        normalized = normalized.replaceAll("(?m)^[ \\t]+$", "");
        normalized = normalized.replaceAll("\n{3,}", "\n\n");
        normalized = normalized.replaceAll("^(?:\\s*\\n)+", "");
        normalized = normalized.replaceAll("(?:\\n\\s*)+$", "");
        return normalized.trim();
    }

    /**
     * Whether two transcript texts denote the same user message. Exact equality wins;
     * otherwise both sides are normalized before comparing, so that a locally built
     * message and the text the provider persisted still match when only formatting,
     * appended context or system tags differ.
     */
    public static boolean matchesUserText(@Nullable String left, @Nullable String right) {
        if (left == null || right == null) {
            return false;
        }
        if (left.equals(right)) {
            return true;
        }
        String normalizedLeft = normalizeForComparison(left);
        if (normalizedLeft.isEmpty()) {
            return false;
        }
        return normalizedLeft.equals(normalizeForComparison(right));
    }

    private static String stripSystemTags(String text) {
        String result = text;
        for (String tag : SYSTEM_TAG_NAMES) {
            result = removeTagBlocks(result, tag);
        }
        return result;
    }

    private static String removeTagBlocks(String text, String tagName) {
        String result = text;
        String openTag = "<" + tagName + ">";
        String closeTag = "</" + tagName + ">";
        int start = result.indexOf(openTag);
        while (start >= 0) {
            int end = result.indexOf(closeTag, start);
            if (end < 0) {
                break;
            }
            result = result.substring(0, start) + result.substring(end + closeTag.length());
            start = result.indexOf(openTag);
        }
        return result;
    }

    private static String stripAppendedContext(String text) {
        int cutIndex = -1;
        for (String marker : APPENDED_CONTEXT_MARKERS) {
            int idx = text.indexOf(marker);
            if (idx <= 0) {
                continue;
            }
            String prefix = text.substring(0, idx).trim();
            if (prefix.isEmpty()) {
                continue;
            }
            if (cutIndex == -1 || idx < cutIndex) {
                cutIndex = idx;
            }
        }
        if (cutIndex < 0) {
            return text;
        }
        return text.substring(0, cutIndex);
    }

    private static String stripCodexImagePlaceholders(String text) {
        String result = text;
        int start = result.indexOf("<image ");
        while (start >= 0) {
            int end = result.indexOf("</image>", start);
            if (end < 0) {
                break;
            }
            result = result.substring(0, start) + result.substring(end + "</image>".length());
            start = result.indexOf("<image ");
        }
        return result;
    }
}
