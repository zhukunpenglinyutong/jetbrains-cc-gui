package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Content rebuild utility.
 * Derives the pre-edit content by reverse-applying edit operations to the post-edit content.
 */
public final class ContentRebuildUtil {

    private static final Logger LOG = Logger.getInstance(ContentRebuildUtil.class);

    private ContentRebuildUtil() {
    }

    /**
     * Reverse-rebuild the pre-edit content from the post-edit content.
     *
     * Note: if the file was modified by a linter/formatter, newString may not match exactly.
     * In that case, whitespace-normalized matching is attempted; if that also fails, the
     * operation is skipped and processing continues.
     */
    public static String rebuildBeforeContent(String afterContent, JsonArray edits) {
        String content = afterContent;

        // Iterate over edit operations in reverse order
        for (int i = edits.size() - 1; i >= 0; i--) {
            JsonObject edit = edits.get(i).getAsJsonObject();
            String oldString = edit.has("oldString") ? edit.get("oldString").getAsString() : "";
            String newString = edit.has("newString") ? edit.get("newString").getAsString() : "";
            boolean replaceAll = edit.has("replaceAll") && edit.get("replaceAll").getAsBoolean();

            if (replaceAll) {
                content = reverseReplaceAll(content, oldString, newString);
            } else {
                content = reverseReplaceSingle(content, oldString, newString);
            }
        }

        LOG.info("Successfully rebuilt before content (" + edits.size() + " operations)");
        return content;
    }

    private static String reverseReplaceAll(String content, String oldString, String newString) {
        // First try exact match
        if (content.contains(newString)) {
            return content.replace(newString, oldString);
        }

        // Try matching with normalized line separators (CRLF vs LF)
        String normalizedNewString = LineSeparatorUtil.normalizeToMatch(newString, content);
        if (!normalizedNewString.equals(newString) && content.contains(normalizedNewString)) {
            String normalizedOldString = LineSeparatorUtil.normalizeToMatch(oldString, content);
            return content.replace(normalizedNewString, normalizedOldString);
        }

        // Try matching with normalized whitespace
        String normalizedNew = normalizeWhitespace(newString);
        String normalizedContent = normalizeWhitespace(content);
        if (normalizedContent.contains(normalizedNew)) {
            return replaceNormalized(content, newString, oldString);
        }
        LOG.warn("rebuildBeforeContent: newString not found (replace_all), skipping operation");
        return content;
    }

    private static String reverseReplaceSingle(String content, String oldString, String newString) {
        // First try exact match
        int index = content.indexOf(newString);
        if (index >= 0) {
            return content.substring(0, index) + oldString + content.substring(index + newString.length());
        }

        // Try matching with normalized line separators (CRLF vs LF)
        String normalizedNewString = LineSeparatorUtil.normalizeToMatch(newString, content);
        if (!normalizedNewString.equals(newString)) {
            index = content.indexOf(normalizedNewString);
            if (index >= 0) {
                String normalizedOldString = LineSeparatorUtil.normalizeToMatch(oldString, content);
                return content.substring(0, index) + normalizedOldString
                        + content.substring(index + normalizedNewString.length());
            }
        }

        // Try matching with normalized whitespace
        int fuzzyIndex = findNormalizedIndex(content, newString);
        if (fuzzyIndex >= 0) {
            int actualEnd = findActualEndIndex(content, fuzzyIndex, newString);
            return content.substring(0, fuzzyIndex) + oldString + content.substring(actualEnd);
        }
        LOG.warn("rebuildBeforeContent: newString not found, skipping operation");
        return content;
    }

    /**
     * Normalize whitespace characters (for fuzzy matching).
     */
    static String normalizeWhitespace(String s) {
        if (s == null) return "";
        return s.replaceAll("\\s+", " ").trim();
    }

    /**
     * Find the position of a substring after normalizing whitespace.
     */
    static int findNormalizedIndex(String content, String target) {
        String normalizedTarget = normalizeWhitespace(target);
        // Normalize line separators to LF for consistent processing
        String normalizedContent = LineSeparatorUtil.normalizeToLF(content);
        String[] lines = normalizedContent.split("\n", -1);
        int charIndex = 0;

        for (int lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            StringBuilder remainingBuilder = new StringBuilder();
            for (int j = lineIdx; j < lines.length; j++) {
                if (j > lineIdx) remainingBuilder.append("\n");
                remainingBuilder.append(lines[j]);
            }
            String normalizedRemaining = normalizeWhitespace(remainingBuilder.toString());

            if (normalizedRemaining.startsWith(normalizedTarget) ||
                normalizedRemaining.contains(normalizedTarget)) {
                // Map back to original content position
                return LineSeparatorUtil.mapToOriginalPosition(content, normalizedContent, charIndex);
            }
            charIndex += lines[lineIdx].length() + 1;
        }
        return -1;
    }

    /**
     * Find the actual end index, accounting for whitespace differences.
     */
    static int findActualEndIndex(String content, int startIndex, String target) {
        String normalizedTarget = normalizeWhitespace(target);
        int targetNormalizedLen = normalizedTarget.length();

        int normalizedCount = 0;
        int actualIndex = startIndex;

        while (actualIndex < content.length() && normalizedCount < targetNormalizedLen) {
            char c = content.charAt(actualIndex);
            if (!Character.isWhitespace(c) ||
                (normalizedCount > 0 && normalizedCount < normalizedTarget.length() &&
                 normalizedTarget.charAt(normalizedCount) == ' ')) {
                normalizedCount++;
            }
            actualIndex++;
        }

        // Skip trailing whitespace (but not line breaks, including \r and \n)
        while (actualIndex < content.length() &&
               Character.isWhitespace(content.charAt(actualIndex)) &&
               content.charAt(actualIndex) != '\n' &&
               content.charAt(actualIndex) != '\r') {
            actualIndex++;
        }

        return actualIndex;
    }

    /**
     * Perform a replacement using normalized matching.
     */
    static String replaceNormalized(String content, String target, String replacement) {
        int index = findNormalizedIndex(content, target);
        if (index < 0) return content;

        int endIndex = findActualEndIndex(content, index, target);
        return content.substring(0, index) + replacement + content.substring(endIndex);
    }
}
