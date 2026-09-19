package com.github.claudecodegui.service.commit;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import org.jetbrains.annotations.NotNull;

import java.util.Collection;

/**
 * Optional git4idea-backed diff producer.
 *
 * <p>Registered only from {@code git-features.xml}, so the implementation is
 * absent in Git-less IDE configurations. Callers must treat a missing service
 * as "use the content fallback".</p>
 */
public interface GitDiffBackend {

    /**
     * Build a unified {@code git diff} for the selected changes.
     *
     * @param project the current project
     * @param changes the selected VCS changes
     * @return diff text, or empty when git produced nothing
     */
    @NotNull
    String diff(@NotNull Project project, @NotNull Collection<Change> changes);
}
