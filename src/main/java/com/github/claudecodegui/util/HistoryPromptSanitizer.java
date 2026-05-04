package com.github.claudecodegui.util;

import org.jetbrains.annotations.Nullable;

/**
 * Removes system/injected prompt wrappers from persisted history text so UI surfaces only user-visible input.
 */
public final class HistoryPromptSanitizer {

    private static final String AGENT_ROLE_SECTION_MARKER = "## Agent Role and Instructions";
    private static final String AUTO_INJECTED_SECTION_MARKER = "## Auto Injected Prompt Instructions";
    private static final String MESSAGE_PROMPT_SEPARATOR = "\n\n---\n\n";
    private static final String[] SYSTEM_TAG_NAMES = {"agents-instructions", "system-reminder", "system-prompt"};

    private HistoryPromptSanitizer() {
    }

    /**
     * Sanitize history text for display/title extraction.
     */
    @Nullable
    public static String sanitizeForHistory(@Nullable String text) {
        String sanitized = TextSanitizer.sanitizeInvalidSurrogates(text);
        if (sanitized == null || sanitized.isEmpty()) {
            return sanitized;
        }

        sanitized = removeSystemTagBlocks(sanitized);
        sanitized = stripInjectedPromptEnvelope(sanitized);
        return sanitized.trim();
    }

    private static String removeSystemTagBlocks(String text) {
        String result = text;
        for (String tagName : SYSTEM_TAG_NAMES) {
            result = removeAllTagBlocks(result, tagName);
        }
        return result;
    }

    private static String removeAllTagBlocks(String text, String tagName) {
        String result = text;
        String openTag = "<" + tagName + ">";
        String closeTag = "</" + tagName + ">";
        while (true) {
            int start = result.indexOf(openTag);
            if (start == -1) {
                break;
            }
            int end = result.indexOf(closeTag, start);
            if (end == -1) {
                break;
            }
            result = result.substring(0, start) + result.substring(end + closeTag.length());
        }
        return result;
    }

    private static String stripInjectedPromptEnvelope(String text) {
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            return trimmed;
        }

        int lastSeparator = trimmed.lastIndexOf(MESSAGE_PROMPT_SEPARATOR);
        if (lastSeparator < 0) {
            return trimmed;
        }
        if (!looksLikeInjectedPromptPrefix(trimmed, lastSeparator)) {
            return trimmed;
        }

        String userPortion = trimmed.substring(lastSeparator + MESSAGE_PROMPT_SEPARATOR.length()).trim();
        return userPortion.isEmpty() ? trimmed : userPortion;
    }

    private static boolean looksLikeInjectedPromptPrefix(String text, int separatorIndex) {
        String prefix = text.substring(0, separatorIndex).trim();
        if (prefix.isEmpty()) {
            return false;
        }
        return prefix.startsWith(AGENT_ROLE_SECTION_MARKER)
                || prefix.startsWith(AUTO_INJECTED_SECTION_MARKER)
                || prefix.contains(AGENT_ROLE_SECTION_MARKER)
                || prefix.contains(AUTO_INJECTED_SECTION_MARKER);
    }
}
