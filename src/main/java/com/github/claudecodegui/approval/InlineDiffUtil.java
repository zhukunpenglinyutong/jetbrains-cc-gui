package com.github.claudecodegui.approval;

import com.github.claudecodegui.util.LineSeparatorUtil;
import org.jetbrains.annotations.NotNull;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Utilities for computing and applying line-based inline approval hunks.
 */
public final class InlineDiffUtil {

    /**
     * Maximum product of (beforeCount * afterCount) for the O(n*m) LCS matrix.
     * 4 000 000 cells ≈ 16 MB of int[], which covers files up to ~2000 lines
     * on each side comfortably.
     */
    private static final long MAX_MATRIX_PRODUCT = 4_000_000L;

    /** Maximum equal-line gap between two hunks that will be merged into one. */
    private static final int MERGE_CONTEXT_LINES = 3;

    private InlineDiffUtil() {
    }

    @NotNull
    public static String normalize(@NotNull String content) {
        return LineSeparatorUtil.normalizeToLF(content);
    }

    @NotNull
    public static List<InlineDiffHunk> computeHunks(
            @NotNull String beforeContent,
            @NotNull String afterContent
    ) {
        String normalizedBefore = normalize(beforeContent);
        String normalizedAfter = normalize(afterContent);
        if (normalizedBefore.equals(normalizedAfter)) {
            return Collections.emptyList();
        }

        List<String> beforeLines = splitLines(normalizedBefore);
        List<String> afterLines = splitLines(normalizedAfter);

        int prefix = 0;
        int beforeLimit = beforeLines.size();
        int afterLimit = afterLines.size();
        while (prefix < beforeLimit
                && prefix < afterLimit
                && beforeLines.get(prefix).equals(afterLines.get(prefix))) {
            prefix++;
        }

        int beforeSuffix = beforeLimit;
        int afterSuffix = afterLimit;
        while (beforeSuffix > prefix
                && afterSuffix > prefix
                && beforeLines.get(beforeSuffix - 1).equals(afterLines.get(afterSuffix - 1))) {
            beforeSuffix--;
            afterSuffix--;
        }

        List<String> beforeMiddle = beforeLines.subList(prefix, beforeSuffix);
        List<String> afterMiddle = afterLines.subList(prefix, afterSuffix);

        if (beforeMiddle.isEmpty() && afterMiddle.isEmpty()) {
            return Collections.emptyList();
        }

        List<Operation> operations = shouldUseMatrix(beforeMiddle.size(), afterMiddle.size())
                ? computeOperations(beforeMiddle, afterMiddle)
                : fallbackOperations(beforeMiddle, afterMiddle);

        List<InlineDiffHunk> hunks = new ArrayList<>();
        int beforeIndex = prefix;
        int afterIndex = prefix;
        int hunkBeforeStart = -1;
        int hunkAfterStart = -1;
        List<String> hunkBeforeLines = new ArrayList<>();
        List<String> hunkAfterLines = new ArrayList<>();

        for (Operation operation : operations) {
            switch (operation) {
                case EQUAL -> {
                    if (!hunkBeforeLines.isEmpty() || !hunkAfterLines.isEmpty()) {
                        hunks.add(buildHunk(
                                hunkBeforeStart,
                                beforeIndex,
                                hunkAfterStart,
                                afterIndex,
                                hunkBeforeLines,
                                hunkAfterLines
                        ));
                        hunkBeforeLines = new ArrayList<>();
                        hunkAfterLines = new ArrayList<>();
                        hunkBeforeStart = -1;
                        hunkAfterStart = -1;
                    }
                    beforeIndex++;
                    afterIndex++;
                }
                case DELETE -> {
                    if (hunkBeforeStart < 0) {
                        hunkBeforeStart = beforeIndex;
                        hunkAfterStart = afterIndex;
                    }
                    hunkBeforeLines.add(beforeLines.get(beforeIndex));
                    beforeIndex++;
                }
                case INSERT -> {
                    if (hunkBeforeStart < 0) {
                        hunkBeforeStart = beforeIndex;
                        hunkAfterStart = afterIndex;
                    }
                    hunkAfterLines.add(afterLines.get(afterIndex));
                    afterIndex++;
                }
            }
        }

        if (!hunkBeforeLines.isEmpty() || !hunkAfterLines.isEmpty()) {
            hunks.add(buildHunk(
                    hunkBeforeStart,
                    beforeIndex,
                    hunkAfterStart,
                    afterIndex,
                    hunkBeforeLines,
                    hunkAfterLines
            ));
        }

        return mergeAdjacentHunks(hunks, beforeLines, afterLines);
    }

    @NotNull
    public static String applyToBaseline(@NotNull String baselineContent, @NotNull InlineDiffHunk hunk) {
        return replaceLineRange(
                baselineContent,
                hunk.getBeforeStartLine(),
                hunk.getBeforeEndLineExclusive(),
                hunk.getAfterText()
        );
    }

    @NotNull
    public static String revertFromCurrent(@NotNull String currentContent, @NotNull InlineDiffHunk hunk) {
        return replaceLineRange(
                currentContent,
                hunk.getAfterStartLine(),
                hunk.getAfterEndLineExclusive(),
                hunk.getBeforeText()
        );
    }

    @NotNull
    public static String replaceLineRange(
            @NotNull String content,
            int startLine,
            int endLineExclusive,
            @NotNull String replacement
    ) {
        List<String> lines = new ArrayList<>(splitLines(normalize(content)));
        int safeStart = Math.max(0, Math.min(startLine, lines.size()));
        int safeEnd = Math.max(safeStart, Math.min(endLineExclusive, lines.size()));

        List<String> replacementLines = splitLines(normalize(replacement));
        lines.subList(safeStart, safeEnd).clear();
        lines.addAll(safeStart, replacementLines);
        return joinLines(lines);
    }

    @NotNull
    public static List<String> splitLines(@NotNull String content) {
        String normalized = normalize(content);
        if (normalized.isEmpty()) {
            return new ArrayList<>();
        }
        String[] parts = normalized.split("\n", -1);
        List<String> lines = new ArrayList<>(parts.length);
        Collections.addAll(lines, parts);
        return lines;
    }

    @NotNull
    public static String joinLines(@NotNull List<String> lines) {
        return String.join("\n", lines);
    }

    private static boolean shouldUseMatrix(int beforeCount, int afterCount) {
        return (long) beforeCount * afterCount <= MAX_MATRIX_PRODUCT;
    }

    /**
     * Greedy forward-matching fallback for large middle sections that exceed
     * the O(n*m) matrix budget.  For each before-line, we find the earliest
     * matching after-line (at or after the current pointer) to keep ordering.
     * Lines between matches become INSERT; unmatched before-lines become DELETE.
     * This is much better than the naive "delete all + insert all" for files
     * where most lines are unchanged.
     */
    @NotNull
    private static List<Operation> fallbackOperations(
            @NotNull List<String> beforeLines,
            @NotNull List<String> afterLines
    ) {
        // Build a position index for after-lines
        Map<String, List<Integer>> afterPositions = new HashMap<>();
        for (int j = 0; j < afterLines.size(); j++) {
            afterPositions.computeIfAbsent(afterLines.get(j), k -> new ArrayList<>()).add(j);
        }

        List<Operation> operations = new ArrayList<>();
        int afterPointer = 0;

        for (int bi = 0; bi < beforeLines.size(); bi++) {
            List<Integer> positions = afterPositions.get(beforeLines.get(bi));
            int matchPos = -1;
            if (positions != null) {
                for (int pos : positions) {
                    if (pos >= afterPointer) {
                        matchPos = pos;
                        break;
                    }
                }
            }

            if (matchPos >= 0) {
                // Emit INSERT for any skipped after-lines before this match
                while (afterPointer < matchPos) {
                    operations.add(Operation.INSERT);
                    afterPointer++;
                }
                operations.add(Operation.EQUAL);
                afterPointer++;
            } else {
                operations.add(Operation.DELETE);
            }
        }

        // Emit INSERT for remaining after-lines
        while (afterPointer < afterLines.size()) {
            operations.add(Operation.INSERT);
            afterPointer++;
        }
        return operations;
    }

    @NotNull
    private static List<Operation> computeOperations(
            @NotNull List<String> beforeLines,
            @NotNull List<String> afterLines
    ) {
        int beforeCount = beforeLines.size();
        int afterCount = afterLines.size();
        int[][] dp = new int[beforeCount + 1][afterCount + 1];

        for (int i = beforeCount - 1; i >= 0; i--) {
            for (int j = afterCount - 1; j >= 0; j--) {
                if (beforeLines.get(i).equals(afterLines.get(j))) {
                    dp[i][j] = dp[i + 1][j + 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
                }
            }
        }

        List<Operation> operations = new ArrayList<>();
        int i = 0;
        int j = 0;
        while (i < beforeCount && j < afterCount) {
            if (beforeLines.get(i).equals(afterLines.get(j))) {
                operations.add(Operation.EQUAL);
                i++;
                j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                operations.add(Operation.DELETE);
                i++;
            } else {
                operations.add(Operation.INSERT);
                j++;
            }
        }
        while (i < beforeCount) {
            operations.add(Operation.DELETE);
            i++;
        }
        while (j < afterCount) {
            operations.add(Operation.INSERT);
            j++;
        }
        return operations;
    }

    @NotNull
    private static InlineDiffHunk buildHunk(
            int beforeStart,
            int beforeEndExclusive,
            int afterStart,
            int afterEndExclusive,
            @NotNull List<String> beforeLines,
            @NotNull List<String> afterLines
    ) {
        InlineDiffHunk.Type type;
        if (beforeLines.isEmpty()) {
            type = InlineDiffHunk.Type.ADDED;
        } else if (afterLines.isEmpty()) {
            type = InlineDiffHunk.Type.DELETED;
        } else {
            type = InlineDiffHunk.Type.MODIFIED;
        }

        return new InlineDiffHunk(
                UUID.randomUUID().toString(),
                type,
                beforeStart,
                beforeEndExclusive,
                afterStart,
                afterEndExclusive,
                joinLines(beforeLines),
                joinLines(afterLines)
        );
    }

    /**
     * Merge adjacent hunks separated by ≤ {@link #MERGE_CONTEXT_LINES} equal lines.
     * This prevents unnecessary splitting when the LCS algorithm finds a few matching
     * context lines (e.g. a closing brace) in the middle of a continuous edit block.
     */
    @NotNull
    private static List<InlineDiffHunk> mergeAdjacentHunks(
            @NotNull List<InlineDiffHunk> hunks,
            @NotNull List<String> beforeLines,
            @NotNull List<String> afterLines
    ) {
        if (hunks.size() <= 1) {
            return hunks;
        }

        List<InlineDiffHunk> result = new ArrayList<>();
        InlineDiffHunk current = hunks.get(0);

        for (int i = 1; i < hunks.size(); i++) {
            InlineDiffHunk next = hunks.get(i);

            int afterGap = next.getAfterStartLine() - current.getAfterEndLineExclusive();
            int beforeGap = next.getBeforeStartLine() - current.getBeforeEndLineExclusive();

            if (afterGap >= 0 && beforeGap >= 0
                    && afterGap <= MERGE_CONTEXT_LINES
                    && beforeGap <= MERGE_CONTEXT_LINES) {
                // Extract gap lines from their respective sides.
                // The before-gap and after-gap are the same textual content (EQUAL lines)
                // but live at different indices in beforeLines / afterLines because
                // prior INSERT/DELETE operations shift the after-index independently.
                // Using the correct side's lines ensures applyToBaseline and
                // revertFromCurrent see the right content at the right position.
                String beforeGapText = extractGapText(beforeLines,
                        current.getBeforeEndLineExclusive(), next.getBeforeStartLine());
                String afterGapText = extractGapText(afterLines,
                        current.getAfterEndLineExclusive(), next.getAfterStartLine());

                // Safety: if the gap content differs between sides (can happen when one
                // hunk is a pure DELETE or pure ADD that causes index divergence), don't
                // merge — otherwise the merged hunk's inner diff would misidentify the
                // asymmetric gap lines as deleted/added context.
                if (!beforeGapText.equals(afterGapText)) {
                    result.add(current);
                    current = next;
                    continue;
                }

                String mergedBefore = joinNonEmpty(current.getBeforeText(), beforeGapText, next.getBeforeText());
                String mergedAfter = joinNonEmpty(current.getAfterText(), afterGapText, next.getAfterText());

                InlineDiffHunk.Type type;
                if (mergedBefore.isEmpty()) {
                    type = InlineDiffHunk.Type.ADDED;
                } else if (mergedAfter.isEmpty()) {
                    type = InlineDiffHunk.Type.DELETED;
                } else {
                    type = InlineDiffHunk.Type.MODIFIED;
                }

                current = new InlineDiffHunk(
                        UUID.randomUUID().toString(),
                        type,
                        current.getBeforeStartLine(),
                        next.getBeforeEndLineExclusive(),
                        current.getAfterStartLine(),
                        next.getAfterEndLineExclusive(),
                        mergedBefore,
                        mergedAfter
                );
            } else {
                result.add(current);
                current = next;
            }
        }
        result.add(current);
        return result;
    }

    @NotNull
    private static String extractGapText(@NotNull List<String> lines, int start, int endExclusive) {
        if (start >= endExclusive || start >= lines.size()) {
            return "";
        }
        return joinLines(lines.subList(start, Math.min(endExclusive, lines.size())));
    }

    @NotNull
    private static String joinNonEmpty(@NotNull String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String part : parts) {
            if (!part.isEmpty()) {
                if (!sb.isEmpty()) {
                    sb.append("\n");
                }
                sb.append(part);
            }
        }
        return sb.toString();
    }

    private enum Operation {
        EQUAL,
        DELETE,
        INSERT
    }
}
