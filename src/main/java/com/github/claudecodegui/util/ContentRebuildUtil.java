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

            int lengthBefore = content.length();
            if (replaceAll) {
                content = reverseReplaceAll(content, oldString, newString);
            } else {
                content = reverseReplaceSingle(content, oldString, newString);
            }
            boolean reversed = content.length() != lengthBefore || !content.equals(afterContent);
            LOG.info("[rebuildBeforeContent] op " + i
                    + " replaceAll=" + replaceAll
                    + " oldLen=" + oldString.length()
                    + " newLen=" + newString.length()
                    + " newLines=" + countLines(newString)
                    + " contentLenBefore=" + lengthBefore
                    + " contentLenAfter=" + content.length()
                    + " reversed=" + reversed
                    + " newStringHex=[" + hexDump(newString, 300) + "]");
            afterContent = content; // track for next iteration
        }

        LOG.info("Successfully rebuilt before content (" + edits.size() + " operations)");
        return content;
    }

    /** Count newline characters in s (for multi-line detection). */
    private static int countLines(String s) {
        int count = 1;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '\n') count++;
        }
        return count;
    }

    /**
     * Render a string for diagnostic logging: non-printable chars are escaped,
     * newlines become \n, carriage returns become \r, tabs become \t.
     * Truncated to maxChars with length appended when truncated.
     */
    static String hexDump(String s, int maxChars) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder();
        int limit = Math.min(s.length(), maxChars);
        for (int i = 0; i < limit; i++) {
            char c = s.charAt(i);
            if (c == '\n') sb.append("\\n");
            else if (c == '\r') sb.append("\\r");
            else if (c == '\t') sb.append("\\t");
            else if (c < 32 || c > 126) sb.append(String.format("\\x%02X", (int) c));
            else sb.append(c);
        }
        if (s.length() > maxChars) sb.append("...(total ").append(s.length()).append(")");
        return sb.toString();
    }

    private static String reverseReplaceAll(String content, String oldString, String newString) {
        // If newString is empty, content.contains("") is always true and
        // content.replace("", oldString) inserts oldString before every character.
        // This is never correct — skip this operation.
        if (newString.isEmpty()) {
            LOG.warn("rebuildBeforeContent: skipping reverse of pure-insert replaceAll (newString is empty, oldLen=" + oldString.length() + ")");
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
        String newLF2 = newString.replace("\r\n", "\n").replace("\r", "\n");
        LOG.warn("rebuildBeforeContent: newString not found (replace_all). "
                + "newLen=" + newString.length()
                + " foundLF=" + content.contains(newLF2)
                + " foundCRLF=" + content.contains(newLF2.replace("\n", "\r\n"))
                + " newStringHex=[" + hexDump(newString, 200) + "]");
        return content;
    }

    private static String reverseReplaceSingle(String content, String oldString, String newString) {
        // If newString is empty, this was a pure-insert operation.
        // We cannot reliably determine where to re-insert oldString in the content
        // (content.indexOf("") always returns 0), so skip this reverse operation.
        if (newString.isEmpty()) {
            LOG.warn("rebuildBeforeContent: skipping reverse of pure-insert operation (newString is empty, oldLen=" + oldString.length() + ")");
            return content;
        }

        // Prefer a whole-line match: newString starts at a line boundary (preceded by \n
        // or start-of-string) and ends at a line boundary (followed by \n or end-of-string).
        // This avoids replacing a substring that merely appears inside a longer line
        // (e.g. "step = 3;" found inside "private int step = 3;" instead of the intended
        // method-body line "        step = 3;").
        int wholeLineIndex = findWholeLineIndex(content, newString);
        if (wholeLineIndex >= 0) {
            return content.substring(0, wholeLineIndex) + oldString
                    + content.substring(wholeLineIndex + newString.length());
        }

        // Fall back to first substring match (original behaviour) if no whole-line
        // match exists.  This keeps backwards-compatibility for cases where newString
        // legitimately spans partial lines (rare in practice).
        int index = content.indexOf(newString);
        if (index >= 0) {
            return content.substring(0, index) + oldString + content.substring(index + newString.length());
        }

        // Try matching with normalized line separators (CRLF vs LF)
        String normalizedNewString = LineSeparatorUtil.normalizeToMatch(newString, content);
        if (!normalizedNewString.equals(newString)) {
            int nlIndex = findWholeLineIndex(content, normalizedNewString);
            if (nlIndex < 0) {
                nlIndex = content.indexOf(normalizedNewString);
            }
            if (nlIndex >= 0) {
                String normalizedOldString = LineSeparatorUtil.normalizeToMatch(oldString, content);
                return content.substring(0, nlIndex) + normalizedOldString
                        + content.substring(nlIndex + normalizedNewString.length());
            }
        }

        // Try matching with normalized whitespace
        int fuzzyIndex = findNormalizedIndex(content, newString);
        if (fuzzyIndex >= 0) {
            int actualEnd = findActualEndIndex(content, fuzzyIndex, newString);
            return content.substring(0, fuzzyIndex) + oldString + content.substring(actualEnd);
        }
        // Diagnostic: explain exactly why search failed
        String newLF = newString.replace("\r\n", "\n").replace("\r", "\n");
        String newCRLF = newLF.replace("\n", "\r\n");
        boolean foundLF = content.contains(newLF);
        boolean foundCRLF = content.contains(newCRLF);
        boolean foundTrimmed = content.contains(newString.trim());
        // Search for first 20 printable chars as a "prefix probe"
        String probe = newString.replaceAll("[\\r\\n\\t]", " ").trim();
        if (probe.length() > 20) probe = probe.substring(0, 20);
        int probePos = probe.isEmpty() ? -1 : content.indexOf(probe);
        StringBuilder diag = new StringBuilder();
        diag.append("rebuildBeforeContent: newString not found. ");
        diag.append("newLen=").append(newString.length());
        diag.append(" foundLF=").append(foundLF);
        diag.append(" foundCRLF=").append(foundCRLF);
        diag.append(" foundTrimmed=").append(foundTrimmed);
        diag.append(" probePos=").append(probePos);
        if (probePos >= 0) {
            int ctx0 = Math.max(0, probePos - 3);
            int ctx1 = Math.min(content.length(), probePos + newString.length() + 10);
            diag.append(" contentAround=[").append(hexDump(content.substring(ctx0, ctx1), 200)).append("]");
        }
        diag.append(" newStringHex=[").append(hexDump(newString, 200)).append("]");
        LOG.warn(diag.toString());
        return content;
    }

    /**
     * Find the first index where {@code target} occurs in {@code content} as a
     * complete-line sequence: the character immediately before the match must be
     * {@code \n} (or the match is at position 0), and the character immediately
     * after the match must be {@code \n} (or the match reaches the end of content).
     * Returns -1 if no such position exists.
     */
    private static int findWholeLineIndex(String content, String target) {
        if (target.isEmpty()) return -1;
        int index = content.indexOf(target);
        while (index >= 0) {
            boolean atLineStart = (index == 0 || content.charAt(index - 1) == '\n');
            int end = index + target.length();
            boolean atLineEnd = (end == content.length() || content.charAt(end) == '\n');
            if (atLineStart && atLineEnd) {
                return index;
            }
            index = content.indexOf(target, index + 1);
        }
        return -1;
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
