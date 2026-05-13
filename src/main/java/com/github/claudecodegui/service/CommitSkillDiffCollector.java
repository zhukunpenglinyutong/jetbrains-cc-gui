package com.github.claudecodegui.service;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vcs.FilePath;
import com.intellij.openapi.vcs.VcsException;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangesUtil;
import com.intellij.openapi.vcs.changes.ContentRevision;
import org.jetbrains.annotations.NotNull;

import java.nio.file.FileSystems;
import java.nio.file.PathMatcher;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

final class CommitSkillDiffCollector {
    private static final Logger LOG = Logger.getInstance(CommitSkillDiffCollector.class);
    // Skill mode can spend a larger budget on diff context because the selected
    // Skill content is designed to consume structured diff summaries.
    private static final int MAX_TOTAL_DIFF_LENGTH = 12000;
    private static final int MAX_NEW_FILE_CHARS = 1200;
    private static final int MAX_CHANGED_LINES = 80;
    private static final int MAX_LCS_CELLS = 250000;
    private static final long MAX_FILE_CONTENT_CHARS = 16000;
    private static final String DEFAULT_EXCLUDE_PATTERNS = String.join("\n",
            ".env*",
            "*.pem",
            "*.key",
            "*.pfx",
            "*.crt",
            "*.p12",
            "*.jks",
            "*.token",
            "id_rsa*",
            ".aws/credentials",
            ".aws/config",
            ".npmrc",
            ".netrc",
            "kubeconfig",
            ".kube/config",
            ".git-credentials",
            "secrets.*",
            "*.lock",
            "package-lock.json",
            "pnpm-lock.yaml",
            "yarn.lock");

    private final List<PathMatcher> sensitiveMatchers = new ArrayList<>();
    private final int maxTotalDiffLength;

    CommitSkillDiffCollector() {
        this(MAX_TOTAL_DIFF_LENGTH);
    }

    CommitSkillDiffCollector(int maxTotalDiffLength) {
        this.maxTotalDiffLength = maxTotalDiffLength;
        for (String line : DEFAULT_EXCLUDE_PATTERNS.split("\\R")) {
            String pattern = line.trim();
            if (pattern.isEmpty() || pattern.startsWith("#")) {
                continue;
            }
            String normalized = pattern.replace('\\', '/');
            sensitiveMatchers.add(FileSystems.getDefault().getPathMatcher("glob:" + normalized));
            if (!normalized.startsWith("**/")) {
                sensitiveMatchers.add(FileSystems.getDefault().getPathMatcher("glob:**/" + normalized));
            }
        }
    }

    String collect(@NotNull Collection<Change> changes) {
        StringBuilder diff = new StringBuilder();
        int excluded = 0;
        for (Change change : changes) {
            try {
                FilePath filePath = ChangesUtil.getFilePath(change);
                String path = filePath.getPath();
                if (shouldExclude(path)) {
                    excluded++;
                    continue;
                }
                appendChange(diff, change, path);
                if (diff.length() > maxTotalDiffLength) {
                    diff.append("\n... diff truncated because it is too long\n");
                    break;
                }
            } catch (Exception e) {
                LOG.warn("Failed to collect diff for change: " + e.getMessage());
            }
        }
        if (excluded > 0) {
            diff.append("\nFiltered sensitive files: ").append(excluded).append("\n");
        }
        return diff.toString().trim();
    }

    private void appendChange(StringBuilder diff, Change change, String path) throws VcsException {
        diff.append("\n=== ").append(change.getType().name()).append(": ").append(path).append(" ===\n");
        ContentRevision beforeRevision = change.getBeforeRevision();
        ContentRevision afterRevision = change.getAfterRevision();

        if (change.getType() == Change.Type.NEW && afterRevision != null) {
            String content = afterRevision.getContent();
            if (content == null) {
                diff.append("+++ [new binary or unavailable file]\n");
            } else if (isTooLarge(content)) {
                diff.append("+++ [new file is too large and was omitted]\n");
            } else {
                int end = Math.min(content.length(), MAX_NEW_FILE_CHARS);
                diff.append("+++ ").append(content, 0, end).append("\n");
                if (content.length() > end) {
                    diff.append("... new file truncated\n");
                }
            }
            return;
        }

        if (change.getType() == Change.Type.DELETED) {
            diff.append("--- file deleted\n");
            return;
        }

        if (beforeRevision == null || afterRevision == null) {
            diff.append("[content unavailable]\n");
            return;
        }
        String before = beforeRevision.getContent();
        String after = afterRevision.getContent();
        if (before == null || after == null) {
            diff.append("[binary or unavailable content]\n");
            return;
        }
        if (isTooLarge(before) || isTooLarge(after)) {
            diff.append("[large file content omitted]\n");
            return;
        }
        diff.append(lineDiff(before, after));
    }

    private String lineDiff(String before, String after) {
        String[] beforeLines = before.split("\\R", -1);
        String[] afterLines = after.split("\\R", -1);
        long lcsCells = (long) (beforeLines.length + 1) * (afterLines.length + 1);
        if (lcsCells > MAX_LCS_CELLS) {
            return positionalLineDiff(beforeLines, afterLines);
        }

        int[][] lcs = new int[beforeLines.length + 1][afterLines.length + 1];
        for (int i = beforeLines.length - 1; i >= 0; i--) {
            for (int j = afterLines.length - 1; j >= 0; j--) {
                if (beforeLines[i].equals(afterLines[j])) {
                    lcs[i][j] = lcs[i + 1][j + 1] + 1;
                } else {
                    lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
                }
            }
        }

        StringBuilder out = new StringBuilder();
        int i = 0;
        int j = 0;
        int shown = 0;
        while ((i < beforeLines.length || j < afterLines.length) && shown < MAX_CHANGED_LINES) {
            if (i < beforeLines.length && j < afterLines.length && beforeLines[i].equals(afterLines[j])) {
                i++;
                j++;
            } else if (j >= afterLines.length
                    || (i < beforeLines.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
                shown = appendDiffLine(out, "- ", beforeLines[i], shown);
                i++;
            } else {
                shown = appendDiffLine(out, "+ ", afterLines[j], shown);
                j++;
            }
        }
        if (i < beforeLines.length || j < afterLines.length) {
            out.append("... changed lines truncated\n");
        }
        return out.toString();
    }

    private String positionalLineDiff(String[] beforeLines, String[] afterLines) {
        int max = Math.max(beforeLines.length, afterLines.length);
        int shown = 0;
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < max && shown < MAX_CHANGED_LINES; i++) {
            String left = i < beforeLines.length ? beforeLines[i] : "";
            String right = i < afterLines.length ? afterLines[i] : "";
            if (!left.equals(right)) {
                shown = appendDiffLine(out, "- ", left, shown);
                shown = appendDiffLine(out, "+ ", right, shown);
            }
        }
        if (shown >= MAX_CHANGED_LINES) {
            out.append("... changed lines truncated\n");
        }
        return out.toString();
    }

    private int appendDiffLine(StringBuilder out, String prefix, String line, int shown) {
        if (shown >= MAX_CHANGED_LINES || line == null || line.isEmpty()) {
            return shown;
        }
        out.append(prefix).append(line).append("\n");
        return shown + 1;
    }

    private boolean shouldExclude(String path) {
        if (path == null) {
            return false;
        }
        String normalized = path.replace('\\', '/');
        for (PathMatcher matcher : sensitiveMatchers) {
            if (matcher.matches(Paths.get(normalized))) {
                return true;
            }
        }
        return false;
    }

    private boolean isTooLarge(String content) {
        return content != null && content.length() > MAX_FILE_CONTENT_CHARS;
    }
}
