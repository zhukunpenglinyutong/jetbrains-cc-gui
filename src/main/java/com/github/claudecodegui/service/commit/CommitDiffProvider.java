package com.github.claudecodegui.service.commit;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.FilePath;
import com.intellij.openapi.vcs.VcsException;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangesUtil;
import com.intellij.openapi.vcs.changes.ContentRevision;
import com.intellij.openapi.vfs.VirtualFile;
import git4idea.commands.Git;
import git4idea.commands.GitCommand;
import git4idea.commands.GitCommandResult;
import git4idea.commands.GitLineHandler;
import git4idea.repo.GitRepository;
import git4idea.repo.GitRepositoryManager;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Produces a real, canonical unified {@code git diff} for the user-selected
 * {@link Change}s so the model sees the same diff the user sees in the terminal.
 *
 * <p>Primary path uses git4idea to run {@code git diff HEAD -- <paths>} grouped
 * per repository (one process per repo, not per file — matters on Windows where
 * process spawning is expensive). New (untracked) files are synthesized into a
 * proper unified hunk from their content. If git4idea is unavailable (e.g. the
 * project is null in unit tests, or a file is not under any git repo), it falls
 * back to a content-based diff so the feature degrades gracefully.
 *
 * <p>The content fallback intentionally preserves the legacy line-format so the
 * existing {@code GitCommitMessageServiceCommitAiConfigTest} assertions (which
 * run against mock revisions with a null project) keep passing unchanged.
 */
public class CommitDiffProvider {

    /** Total budget for the assembled diff (~12-16k tokens). */
    private static final int MAX_TOTAL_LENGTH = 50000;
    /** Per-file cap so one huge file cannot consume the whole budget. */
    private static final int MAX_PER_FILE_LENGTH = 12000;
    /** Legacy cap retained by the content fallback for backward compatibility. */
    private static final int LEGACY_MAX_DIFF_LENGTH = 4000;
    private static final int NEW_FILE_LINE_CAP = 200;

    private final Project project;
    private final Logger log;

    public CommitDiffProvider(@Nullable Project project, @NotNull Logger log) {
        this.project = project;
        this.log = log;
    }

    /**
     * Build the unified diff for the given changes.
     *
     * @return the diff text, or empty string when there is nothing to show.
     */
    @NotNull
    public String generate(@NotNull Collection<Change> changes) {
        if (project == null) {
            return contentBasedDiff(changes);
        }
        try {
            String gitDiff = gitBasedDiff(changes);
            if (!gitDiff.trim().isEmpty()) {
                return gitDiff;
            }
        } catch (Throwable t) {
            // git4idea should always be present (declared as a required <depends>),
            // but never let diff generation crash the commit flow.
            log.warn("CommitDiffProvider: git4idea diff failed, falling back to content diff: " + t.getMessage());
        }
        return contentBasedDiff(changes);
    }

    // =========================================================================
    // Primary path: real git diff via git4idea
    // =========================================================================

    @NotNull
    private String gitBasedDiff(@NotNull Collection<Change> changes) {
        GitRepositoryManager mgr = GitRepositoryManager.getInstance(project);

        // Partition: tracked-and-resolvable (grouped by repo) vs new vs unresolved.
        Map<GitRepository, List<Change>> trackedByRepo = new LinkedHashMap<>();
        List<Change> newFiles = new ArrayList<>();
        List<Change> unresolved = new ArrayList<>();

        for (Change change : changes) {
            Change.Type type = change.getType();
            if (type == Change.Type.NEW) {
                newFiles.add(change);
                continue;
            }
            FilePath fp = ChangesUtil.getFilePath(change);
            GitRepository repo = findRepository(mgr, fp);
            if (repo == null || relativePath(repo, fp) == null) {
                unresolved.add(change);
            } else {
                trackedByRepo.computeIfAbsent(repo, r -> new ArrayList<>()).add(change);
            }
        }

        StringBuilder out = new StringBuilder();
        int omittedFiles = 0;

        // One `git diff HEAD -- <paths>` call per repository.
        for (Map.Entry<GitRepository, List<Change>> entry : trackedByRepo.entrySet()) {
            GitRepository repo = entry.getKey();
            List<Change> repoChanges = entry.getValue();
            List<String> relPaths = new ArrayList<>(repoChanges.size());
            for (Change c : repoChanges) {
                relPaths.add(relativePath(repo, ChangesUtil.getFilePath(c)));
            }
            String seg = runGitDiff(repo, relPaths);
            if (seg.trim().isEmpty()) {
                // No HEAD yet, or git returned nothing for these paths — degrade
                // each file to the content fallback rather than dropping it.
                for (Change c : repoChanges) {
                    omittedFiles += appendSegment(out, contentDiffForChangeQuiet(c));
                }
            } else {
                omittedFiles += appendSegment(out, capPerFile(seg));
            }
        }

        for (Change c : newFiles) {
            omittedFiles += appendSegment(out, synthesizeNewFile(c));
        }
        for (Change c : unresolved) {
            omittedFiles += appendSegment(out, contentDiffForChangeQuiet(c));
        }

        if (omittedFiles > 0) {
            out.append("\n... (")
                    .append(omittedFiles)
                    .append(" more file(s) omitted to fit context budget)\n");
        }
        return out.toString();
    }

    /**
     * Append a segment if it fits the total budget; otherwise count it omitted.
     *
     * @return 0 if appended, 1 if omitted.
     */
    private int appendSegment(@NotNull StringBuilder out, @NotNull String segment) {
        if (segment.isEmpty()) {
            return 0;
        }
        if (out.length() + segment.length() > MAX_TOTAL_LENGTH) {
            return 1;
        }
        out.append(segment);
        return 0;
    }

    @NotNull
    private String capPerFile(@NotNull String segment) {
        if (segment.length() <= MAX_PER_FILE_LENGTH) {
            return segment;
        }
        return segment.substring(0, MAX_PER_FILE_LENGTH) + "\n... (single-file diff truncated)\n";
    }

    @NotNull
    private String runGitDiff(@NotNull GitRepository repo, @NotNull List<String> relPaths) {
        try {
            GitLineHandler handler = new GitLineHandler(project, repo.getRoot(), GitCommand.DIFF);
            handler.addParameters("--unified=3", "--no-color", "-M", "--no-ext-diff", "HEAD");
            handler.endOptions();
            handler.addParameters("--");
            for (String p : relPaths) {
                handler.addParameters(p);
            }
            GitCommandResult result = Git.getInstance().runCommand(handler);
            // GitCommandResult.getOutput() returns the stdout lines.
            String output = String.join("\n", result.getOutput());
            return output == null ? "" : output;
        } catch (Throwable t) {
            log.warn("CommitDiffProvider: git diff command failed: " + t.getMessage());
            return "";
        }
    }

    @Nullable
    private GitRepository findRepository(@NotNull GitRepositoryManager mgr, @Nullable FilePath fp) {
        if (fp == null) {
            return null;
        }
        VirtualFile vf = fp.getVirtualFile();
        if (vf != null) {
            GitRepository repo = mgr.getRepositoryForFile(vf);
            if (repo != null) {
                return repo;
            }
        }
        String abs = fp.getPath();
        for (GitRepository r : mgr.getRepositories()) {
            String root = r.getRoot().getPath();
            if (abs.startsWith(root)) {
                return r;
            }
        }
        return null;
    }

    @Nullable
    private String relativePath(@NotNull GitRepository repo, @Nullable FilePath fp) {
        if (fp == null) {
            return null;
        }
        try {
            Path root = Paths.get(repo.getRoot().getPath());
            Path abs = Paths.get(fp.getPath());
            if (!abs.startsWith(root)) {
                return null;
            }
            return root.relativize(abs).toString().replace('\\', '/');
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Synthesize a unified diff for a new (untracked) file from its content.
     */
    @NotNull
    private String synthesizeNewFile(@NotNull Change change) {
        FilePath fp = ChangesUtil.getFilePath(change);
        String path = fp == null ? "(unknown)" : fp.getPath();
        String content = null;
        try {
            ContentRevision after = change.getAfterRevision();
            content = after != null ? after.getContent() : null;
        } catch (VcsException e) {
            log.warn("CommitDiffProvider: failed to read new file content: " + e.getMessage());
        }
        if (content == null) {
            return "";
        }
        String normalized = normalizeLineEndings(content);
        String[] lines = normalized.isEmpty() ? new String[0] : normalized.split("\n", -1);
        boolean truncated = lines.length > NEW_FILE_LINE_CAP;
        int shown = truncated ? NEW_FILE_LINE_CAP : lines.length;

        StringBuilder sb = new StringBuilder();
        sb.append("diff --git a/").append(path).append(" b/").append(path).append("\n");
        sb.append("new file mode 100644\n");
        sb.append("--- /dev/null\n");
        sb.append("+++ b/").append(path).append("\n");
        sb.append("@@ -0,0 +1,").append(shown).append(" @@\n");
        for (int i = 0; i < shown; i++) {
            sb.append("+").append(lines[i]).append("\n");
        }
        if (truncated) {
            sb.append("... (new file truncated at ").append(NEW_FILE_LINE_CAP).append(" lines)\n");
        }
        return sb.toString();
    }

    // =========================================================================
    // Fallback path: content-based diff (legacy format, preserves test contract)
    // =========================================================================

    @NotNull
    private String contentBasedDiff(@NotNull Collection<Change> changes) {
        StringBuilder diff = new StringBuilder();
        for (Change change : changes) {
            String segment;
            try {
                segment = contentDiffForChange(change);
            } catch (VcsException e) {
                log.warn("CommitDiffProvider: failed to get diff for change: " + e.getMessage());
                continue;
            }
            if (segment.isEmpty()) {
                continue;
            }
            if (diff.length() + segment.length() > LEGACY_MAX_DIFF_LENGTH) {
                diff.append("\n... (diff 过长，已截断)");
                break;
            }
            diff.append(segment);
        }
        return diff.toString();
    }

    /** Content fallback for a single change, swallowing VcsException (git path). */
    @NotNull
    private String contentDiffForChangeQuiet(@NotNull Change change) {
        try {
            return contentDiffForChange(change);
        } catch (VcsException e) {
            log.warn("CommitDiffProvider: failed to get diff for change: " + e.getMessage());
            return "";
        }
    }

    /**
     * Legacy per-change content diff. Returns the segment, or {@code ""} when
     * there is no real change (e.g. line-ending-only diff) — matching the
     * original rollback behavior.
     */
    @NotNull
    private String contentDiffForChange(@NotNull Change change) throws VcsException {
        FilePath filePath = ChangesUtil.getFilePath(change);
        Change.Type type = change.getType();
        String path = filePath == null ? "(unknown)" : filePath.getPath();

        StringBuilder seg = new StringBuilder();
        seg.append("\n=== ").append(type.name()).append(": ").append(path).append(" ===\n");

        ContentRevision beforeRevision = change.getBeforeRevision();
        ContentRevision afterRevision = change.getAfterRevision();

        if (type == Change.Type.NEW && afterRevision != null) {
            String content = afterRevision.getContent();
            if (content != null) {
                if (content.length() <= 500) {
                    seg.append("+++ ").append(content).append("\n");
                } else {
                    seg.append("+++ [文件过大，仅显示前500字符]\n");
                    seg.append(content, 0, 500).append("\n");
                }
            }
        } else if (type == Change.Type.DELETED && beforeRevision != null) {
            seg.append("--- 文件已删除\n");
        } else if (type == Change.Type.MODIFICATION && beforeRevision != null && afterRevision != null) {
            String before = beforeRevision.getContent();
            String after = afterRevision.getContent();
            if (before != null && after != null) {
                String simpleDiff = generateSimpleDiff(before, after);
                if (simpleDiff.isEmpty()) {
                    // Pure line-ending change (or no change) — drop this file.
                    return "";
                }
                seg.append(simpleDiff);
            }
        }
        return seg.toString();
    }

    /**
     * Generate a simple added/removed-line diff (legacy fallback only).
     * Kept verbatim to preserve existing test assertions.
     */
    @NotNull
    private String generateSimpleDiff(@NotNull String before, @NotNull String after) {
        String normalizedBefore = normalizeLineEndings(before);
        String normalizedAfter = normalizeLineEndings(after);
        if (normalizedBefore.equals(normalizedAfter)) {
            return "";
        }

        String[] beforeLines = normalizedBefore.split("\n");
        String[] afterLines = normalizedAfter.split("\n");

        StringBuilder diff = new StringBuilder();
        int maxLines = Math.max(beforeLines.length, afterLines.length);
        int shownLines = 0;
        int maxShownLines = 30;

        for (int i = 0; i < maxLines && shownLines < maxShownLines; i++) {
            String beforeLine = i < beforeLines.length ? beforeLines[i] : "";
            String afterLine = i < afterLines.length ? afterLines[i] : "";

            if (!beforeLine.equals(afterLine)) {
                if (!beforeLine.isEmpty()) {
                    diff.append("- ").append(beforeLine).append("\n");
                    shownLines++;
                }
                if (!afterLine.isEmpty() && shownLines < maxShownLines) {
                    diff.append("+ ").append(afterLine).append("\n");
                    shownLines++;
                }
            }
        }

        if (maxLines > maxShownLines) {
            diff.append("... (更多变更已省略)\n");
        }

        return diff.toString();
    }

    @NotNull
    private String normalizeLineEndings(@NotNull String content) {
        return content.replace("\r\n", "\n").replace('\r', '\n');
    }
}
