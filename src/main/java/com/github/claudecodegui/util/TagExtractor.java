package com.github.claudecodegui.util;

/**
 * Utility class for extracting content from XML-like tags.
 * Used by ClaudeHistoryReader and CodexHistoryReader to parse command messages.
 */
public final class TagExtractor {

    private TagExtractor() {
        // Utility class, prevent instantiation
    }

    /**
     * Extract content from command-message and command-args tags.
     * Returns the combined content: "command-message content command-args content"
     *
     * @param text the text containing tags
     * @return extracted content or original text if no tags found
     */
    public static String extractCommandMessageContent(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }

        String message = extractTagContent(text, "command-message");
        String args = extractTagContent(text, "command-args");

        if ((message == null || message.isEmpty()) && (args == null || args.isEmpty())) {
            return text;
        }

        StringBuilder sb = new StringBuilder();
        if (message != null && !message.isEmpty()) {
            sb.append(message);
        }
        if (args != null && !args.isEmpty()) {
            if (sb.length() > 0) {
                sb.append(" ");
            }
            sb.append(args);
        }

        return sb.length() > 0 ? sb.toString() : text;
    }

    /**
     * Extract content between opening and closing tags.
     *
     * @param text the text to search in
     * @param tagName the name of the tag (without angle brackets)
     * @return the content between tags, or null if not found
     */
    public static String extractTagContent(String text, String tagName) {
        if (text == null || text.isEmpty() || tagName == null || tagName.isEmpty()) {
            return null;
        }

        String openTag = "<" + tagName + ">";
        String closeTag = "</" + tagName + ">";

        int start = text.indexOf(openTag);
        if (start == -1) {
            return null;
        }
        int end = text.indexOf(closeTag, start + openTag.length());
        if (end == -1) {
            return null;
        }

        String content = text.substring(start + openTag.length(), end).trim();
        return content.isEmpty() ? null : content;
    }
}
