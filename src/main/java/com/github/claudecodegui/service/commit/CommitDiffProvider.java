package com.github.claudecodegui.service.commit;

import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.Collection;

/**
 * Produces a real, canonical unified {@code git diff} for the user-selected
 * {@link Change}s so the model sees the same diff the user sees in the terminal.
 *
 * <p>Primary path uses the optional {@link GitDiffBackend} (git4idea, registered
 * only from {@code git-features.xml}) to run {@code git diff HEAD -- <paths>}
 * grouped per repository. New (untracked) files are synthesized into a proper
 * unified hunk from their content. If git4idea is unavailable (Git-less IDE,
 * null project in unit tests, or a file not under any git repo), it falls back
 * to the content-based diff in {@link ContentDiffSupport} so the feature
 * degrades gracefully.
 */
public class CommitDiffProvider {

    private final Project project;
    private final Logger log;
    private final ContentDiffSupport contentSupport;

    public CommitDiffProvider(@Nullable Project project, @NotNull Logger log) {
        this.project = project;
        this.log = log;
        this.contentSupport = new ContentDiffSupport(log);
    }

    /**
     * Build the unified diff for the given changes.
     *
     * @param changes the selected VCS changes
     * @return the diff text, or empty string when there is nothing to show.
     */
    @NotNull
    public String generate(@NotNull Collection<Change> changes) {
        if (this.project == null) {
            return this.contentSupport.contentBasedDiff(changes);
        }
        GitDiffBackend backend = this.findGitBackend();
        if (backend != null) {
            try {
                String gitDiff = backend.diff(this.project, changes);
                if (gitDiff != null && !gitDiff.trim().isEmpty()) {
                    return gitDiff;
                }
            } catch (RuntimeException t) {
                this.log.warn("CommitDiffProvider: git4idea diff failed, falling back to content diff: "
                        + t.getMessage());
            }
        }
        return this.contentSupport.contentBasedDiff(changes);
    }

    /**
     * Resolve the optional git4idea backend without mentioning its implementation
     * class. A missing Application or unregistered service means Git4Idea is not
     * loaded; the content fallback then owns the diff.
     *
     * @return the registered backend, or null when Git4Idea is absent
     */
    @Nullable
    private GitDiffBackend findGitBackend() {
        try {
            Application app = ApplicationManager.getApplication();
            if (app == null) {
                return null;
            }
            return app.getService(GitDiffBackend.class);
        } catch (RuntimeException e) {
            this.log.debug("CommitDiffProvider: Git4Idea backend is unavailable: " + e.getMessage());
            return null;
        }
    }
}
