package com.github.claudecodegui.util;

import java.util.ArrayList;
import java.util.List;

/**
 * Builds Claude-compatible edit/write operations from before/after text snapshots.
 */
public final class EditOperationBuilder {

    private static final int CONTEXT_LINES = 2;

    private EditOperationBuilder() {
    }

    public static List<Operation> build(String filePath, boolean existedBefore, String beforeContent, String afterContent) {
        String before = beforeContent != null ? beforeContent : "";
        String after = afterContent != null ? afterContent : "";
        if (containsNullByte(before) || containsNullByte(after)) {
            return List.of();
        }
        if (!existedBefore) {
            if (after.isEmpty()) {
                return List.of();
            }
            return List.of(new Operation("write", filePath, "", after, false, 1, Math.max(1, countLines(after)), true));
        }
        if (before.equals(after)) {
            return List.of();
        }

        List<String> beforeLines = splitLinesPreserveEndings(before);
        List<String> afterLines = splitLinesPreserveEndings(after);
        List<HunkRange> hunks = buildHunkRanges(beforeLines, afterLines);
        if (hunks.isEmpty()) {
            return List.of();
        }

        List<Operation> operations = new ArrayList<>();
        for (HunkRange hunk : hunks) {
            String oldString = join(beforeLines, hunk.oldFrom(), hunk.oldTo());
            String newString = join(afterLines, hunk.newFrom(), hunk.newTo());
            if (oldString.equals(newString)) {
                continue;
            }
            int lineStart = hunk.newFrom() + 1;
            int lineEnd = Math.max(lineStart, hunk.newTo());
            operations.add(new Operation("edit", filePath, oldString, newString, false, lineStart, lineEnd, !newString.isEmpty()));
        }
        return operations;
    }

    private static List<HunkRange> buildHunkRanges(List<String> beforeLines, List<String> afterLines) {
        int beforeSize = beforeLines.size();
        int afterSize = afterLines.size();
        if ((long) beforeSize * (long) afterSize > 200_000L) {
            return List.of(singleHunk(beforeLines, afterLines, 0, beforeSize, 0, afterSize));
        }

        int[][] lcs = new int[beforeSize + 1][afterSize + 1];
        for (int i = beforeSize - 1; i >= 0; i--) {
            for (int j = afterSize - 1; j >= 0; j--) {
                if (beforeLines.get(i).equals(afterLines.get(j))) {
                    lcs[i][j] = lcs[i + 1][j + 1] + 1;
                } else {
                    lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
                }
            }
        }

        List<RawRange> rawRanges = new ArrayList<>();
        int i = 0;
        int j = 0;
        int oldStart = -1;
        int newStart = -1;
        while (i < beforeSize || j < afterSize) {
            if (i < beforeSize && j < afterSize && beforeLines.get(i).equals(afterLines.get(j))) {
                if (oldStart >= 0) {
                    rawRanges.add(new RawRange(oldStart, i, newStart, j));
                    oldStart = -1;
                    newStart = -1;
                }
                i++;
                j++;
                continue;
            }
            if (oldStart < 0) {
                oldStart = i;
                newStart = j;
            }
            if (j < afterSize && (i == beforeSize || lcs[i][j + 1] >= lcs[i + 1][j])) {
                j++;
            } else if (i < beforeSize) {
                i++;
            }
        }
        if (oldStart >= 0) {
            rawRanges.add(new RawRange(oldStart, i, newStart, j));
        }

        List<HunkRange> hunks = new ArrayList<>();
        for (RawRange raw : rawRanges) {
            HunkRange next = singleHunk(beforeLines, afterLines, raw.oldStart(), raw.oldEnd(), raw.newStart(), raw.newEnd());
            if (!hunks.isEmpty()) {
                HunkRange previous = hunks.get(hunks.size() - 1);
                if (next.oldFrom() <= previous.oldTo() || next.newFrom() <= previous.newTo()) {
                    hunks.set(hunks.size() - 1, new HunkRange(
                            previous.oldFrom(), Math.max(previous.oldTo(), next.oldTo()),
                            previous.newFrom(), Math.max(previous.newTo(), next.newTo())
                    ));
                    continue;
                }
            }
            hunks.add(next);
        }
        return hunks;
    }

    private static HunkRange singleHunk(
            List<String> beforeLines,
            List<String> afterLines,
            int oldChangeStart,
            int oldChangeEnd,
            int newChangeStart,
            int newChangeEnd
    ) {
        int oldFrom = Math.max(0, oldChangeStart - CONTEXT_LINES);
        int newFrom = Math.max(0, newChangeStart - CONTEXT_LINES);
        int oldTo = Math.min(beforeLines.size(), oldChangeEnd + CONTEXT_LINES);
        int newTo = Math.min(afterLines.size(), newChangeEnd + CONTEXT_LINES);
        return new HunkRange(oldFrom, oldTo, newFrom, newTo);
    }

    private static boolean containsNullByte(String content) {
        return content.indexOf('\0') >= 0;
    }

    private static int countLines(String content) {
        if (content.isEmpty()) {
            return 1;
        }
        int lines = 1;
        for (int i = 0; i < content.length(); i++) {
            if (content.charAt(i) == '\n') {
                lines++;
            }
        }
        return lines;
    }

    private static List<String> splitLinesPreserveEndings(String content) {
        List<String> lines = new ArrayList<>();
        if (content.isEmpty()) {
            return lines;
        }
        int start = 0;
        for (int i = 0; i < content.length(); i++) {
            if (content.charAt(i) == '\n') {
                lines.add(content.substring(start, i + 1));
                start = i + 1;
            }
        }
        if (start < content.length()) {
            lines.add(content.substring(start));
        }
        return lines;
    }

    private static String join(List<String> lines, int fromInclusive, int toExclusive) {
        StringBuilder builder = new StringBuilder();
        for (int i = fromInclusive; i < toExclusive; i++) {
            builder.append(lines.get(i));
        }
        return builder.toString();
    }

    private record RawRange(int oldStart, int oldEnd, int newStart, int newEnd) {
    }

    private record HunkRange(int oldFrom, int oldTo, int newFrom, int newTo) {
    }

    public record Operation(
            String toolName,
            String filePath,
            String oldString,
            String newString,
            boolean replaceAll,
            int lineStart,
            int lineEnd,
            boolean safeToRollback
    ) {
    }
}
