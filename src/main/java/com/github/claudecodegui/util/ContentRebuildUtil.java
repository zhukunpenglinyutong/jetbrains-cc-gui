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
     *
     * @return result containing the rebuilt content and whether all operations matched exactly
     */
    public static ContentRebuildResult rebuildBeforeContent(String afterContent, JsonArray edits) {
        String content = afterContent;
        boolean exact = true;

        // Iterate over edit operations in reverse order
        for (int i = edits.size() - 1; i >= 0; i--) {
            JsonObject edit = edits.get(i).getAsJsonObject();
            String oldString = edit.has("oldString") ? edit.get("oldString").getAsString() : "";
            String newString = edit.has("newString") ? edit.get("newString").getAsString() : "";
            boolean replaceAll = edit.has("replaceAll") && edit.get("replaceAll").getAsBoolean();

            String before = content;
            if (replaceAll) {
                content = reverseReplaceAll(content, oldString, newString);
            } else {
                content = reverseReplaceSingle(content, oldString, newString);
            }
            if (exact) {
                exact = wasExactMatch(before, content, oldString, newString, replaceAll);
            }
        }

        LOG.info("Rebuilt before content (" + edits.size() + " operations, exact=" + exact + ")");
        return new ContentRebuildResult(content, exact);
    }

    /**
     * Check whether the reverse operation used exact matching.
     * Returns false (not exact) for:
     * - empty newString with non-empty oldString (indexOf("")==0 / replace("",x) are catastrophic)
     * - operation skipped (content unchanged, newString non-empty)
     * - fuzzy/normalized match (newString not found verbatim in before)
     * - non-replaceAll with newString appearing multiple times (ambiguous which to reverse)
     */
    private static boolean wasExactMatch(
            String before, String after, String oldString, String newString, boolean replaceAll
    ) {
        // Empty newString with non-empty oldString: indexOf("")==0 always "matches",
        // replace("",x) inserts between every char — both catastrophic, never exact
        if (newString.isEmpty()) {
            return oldString.isEmpty(); // both empty = true no-op; delete reverse = not exact
        }

        // Content unchanged means the operation was skipped
        if (before.equals(after)) {
            return false;
        }

        // Content changed — verify newString was found verbatim (exact match path, not fuzzy)
        if (!before.contains(newString)) {
            return false;
        }

        // For non-replaceAll: newString appearing multiple times means indexOf picked
        // an arbitrary occurrence — ambiguous, not reliably exact
        if (!replaceAll) {
            int first = before.indexOf(newString);
            if (before.indexOf(newString, first + 1) >= 0) {
                return false;
            }
        }

        return true;
    }

    private static String reverseReplaceAll(String content, String oldString, String newString) {
        // Guard: empty newString → contains("")==true, replace("",x) inserts between every char
        if (newString.isEmpty()) {
            LOG.warn("rebuildBeforeContent: empty newString in replaceAll reverse, skipping operation");
            return content;
        }

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
        // Guard: empty newString → indexOf("")==0 inserts oldString at position 0
        if (newString.isEmpty()) {
            LOG.warn("rebuildBeforeContent: empty newString in single reverse, skipping operation");
            return content;
        }

        // First try exact match
        int index = content.indexOf(newString);
        if (index >= 0) {
            // Guard: ambiguous if newString appears multiple times — skip rather than guess
            if (content.indexOf(newString, index + 1) >= 0) {
                LOG.warn("rebuildBeforeContent: newString appears multiple times, skipping operation");
                return content;
            }
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
        if (s == null) { return ""; }
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
                if (j > lineIdx) { remainingBuilder.append("\n"); }
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
        if (index < 0) { return content; }

        int endIndex = findActualEndIndex(content, index, target);
        return content.substring(0, index) + replacement + content.substring(endIndex);
    }
}
