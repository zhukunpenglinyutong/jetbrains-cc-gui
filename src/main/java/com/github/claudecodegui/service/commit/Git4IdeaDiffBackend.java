package com.github.claudecodegui.service.commit;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.FilePath;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangesUtil;
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
 * git4idea implementation of {@link GitDiffBackend}.
 *
 * <p>Loaded only when Git4Idea is present: {@code git-features.xml} registers
 * this as an application service. Do not reference this class from always-loaded
 * plugin code.</p>
 */
public final class Git4IdeaDiffBackend implements GitDiffBackend {

    private static final Logger LOG = Logger.getInstance(Git4IdeaDiffBackend.class);

    /**
     * Build a unified git diff grouped per repository.
     *
     * @param project the current project
     * @param changes the selected VCS changes
     * @return diff text, or empty when git produced nothing useful
     */
    @Override
    @NotNull
    public String diff(@NotNull Project project, @NotNull Collection<Change> changes) {
        ContentDiffSupport helpers = new ContentDiffSupport(LOG);
        GitRepositoryManager mgr = GitRepositoryManager.getInstance(project);

        Map<GitRepository, List<Change>> trackedByRepo = new LinkedHashMap<>();
        List<Change> newFiles = new ArrayList<>();
        List<Change> unresolved = new ArrayList<>();

        for (Change change : changes) {
            Change.Type type = change.getType();
            if (type == Change.Type.NEW) {
                newFiles.add(change);
                continue;
            }
            FilePath filePath = ChangesUtil.getFilePath(change);
            GitRepository repo = this.findRepository(mgr, filePath);
            if (repo == null || this.relativePath(repo, filePath) == null) {
                unresolved.add(change);
            } else {
                trackedByRepo.computeIfAbsent(repo, ignored -> new ArrayList<>()).add(change);
            }
        }

        StringBuilder out = new StringBuilder();
        int omittedFiles = 0;

        for (Map.Entry<GitRepository, List<Change>> entry : trackedByRepo.entrySet()) {
            GitRepository repo = entry.getKey();
            List<Change> repoChanges = entry.getValue();
            List<String> relPaths = new ArrayList<>(repoChanges.size());
            for (Change change : repoChanges) {
                relPaths.add(this.relativePath(repo, ChangesUtil.getFilePath(change)));
            }
            String segment = this.runGitDiff(project, repo, relPaths);
            if (segment.trim().isEmpty()) {
                for (Change change : repoChanges) {
                    omittedFiles += helpers.appendSegment(out, helpers.contentDiffForChangeQuiet(change));
                }
            } else {
                omittedFiles += helpers.appendSegment(out, helpers.capPerFile(segment));
            }
        }

        for (Change change : newFiles) {
            omittedFiles += helpers.appendSegment(out, helpers.synthesizeNewFile(change));
        }
        for (Change change : unresolved) {
            omittedFiles += helpers.appendSegment(out, helpers.contentDiffForChangeQuiet(change));
        }

        if (omittedFiles > 0) {
            out.append("\n... (")
                    .append(omittedFiles)
                    .append(" more file(s) omitted to fit context budget)\n");
        }
        return out.toString();
    }

    @NotNull
    private String runGitDiff(
            @NotNull Project project,
            @NotNull GitRepository repo,
            @NotNull List<String> relPaths
    ) {
        try {
            GitLineHandler handler = new GitLineHandler(project, repo.getRoot(), GitCommand.DIFF);
            handler.addParameters("--unified=3", "--no-color", "-M", "--no-ext-diff", "HEAD");
            handler.endOptions();
            handler.addParameters("--");
            for (String relPath : relPaths) {
                handler.addParameters(relPath);
            }
            GitCommandResult result = Git.getInstance().runCommand(handler);
            return String.join("\n", result.getOutput());
        } catch (RuntimeException t) {
            LOG.warn("Git4IdeaDiffBackend: git diff command failed: " + t.getMessage());
            return "";
        }
    }

    @Nullable
    private GitRepository findRepository(@NotNull GitRepositoryManager mgr, @Nullable FilePath filePath) {
        if (filePath == null) {
            return null;
        }
        VirtualFile virtualFile = filePath.getVirtualFile();
        if (virtualFile != null) {
            GitRepository repo = mgr.getRepositoryForFile(virtualFile);
            if (repo != null) {
                return repo;
            }
        }
        String abs = filePath.getPath();
        for (GitRepository repo : mgr.getRepositories()) {
            String root = repo.getRoot().getPath();
            if (abs.startsWith(root)) {
                return repo;
            }
        }
        return null;
    }

    @Nullable
    private String relativePath(@NotNull GitRepository repo, @Nullable FilePath filePath) {
        if (filePath == null) {
            return null;
        }
        try {
            Path root = Paths.get(repo.getRoot().getPath());
            Path abs = Paths.get(filePath.getPath());
            if (!abs.startsWith(root)) {
                return null;
            }
            return root.relativize(abs).toString().replace('\\', '/');
        } catch (RuntimeException t) {
            LOG.debug("Git4IdeaDiffBackend: failed to resolve relative path: " + t.getMessage());
            return null;
        }
    }
}
