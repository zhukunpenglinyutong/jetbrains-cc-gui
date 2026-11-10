package com.github.claudecodegui.util;

import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.roots.ProjectRootManager;
import com.intellij.openapi.util.Computable;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.ArrayList;
import java.util.List;

/**
 * Project-boundary path checks for multi-content-root projects.
 *
 * <p>A project's files can live in the project base directory or in module content
 * roots outside it (for example directories attached as sibling content roots).
 * The boundary is the union of the project base directory and the loaded project
 * model's content roots, so accepting content roots only extends the previous
 * base-only boundary and never narrows it.
 */
public final class ProjectPathUtils {

    private static final Logger LOG = Logger.getInstance(ProjectPathUtils.class);

    private ProjectPathUtils() {
    }

    /**
     * Returns true when {@code filePath} is inside the project base directory or any loaded content root.
     *
     * <p>The boundary is the union of the project base directory and the loaded project model's
     * content roots. Content roots extend the base boundary; the base directory is always accepted,
     * even when it is not itself a content root.
     *
     * <p>Returns false when no boundary can be determined, so callers that gate writes fail closed.
     */
    public static boolean isPathWithinProject(@Nullable Project project, @Nullable String filePath) {
        if (project == null || filePath == null || filePath.isEmpty()) {
            return false;
        }
        return isWithinProjectBoundaries(filePath, project.getBasePath(), getContentRootPaths(project));
    }

    /** Applies the base ∪ content-root boundary rule. Visible for tests. */
    static boolean isWithinProjectBoundaries(
            @NotNull String filePath,
            @Nullable String basePath,
            @NotNull List<String> contentRoots
    ) {
        if (filePath.isEmpty()) {
            return false;
        }
        for (String contentRoot : contentRoots) {
            if (WslPathUtil.isPathWithinDirectory(filePath, contentRoot)) {
                return true;
            }
        }
        return basePath != null && WslPathUtil.isPathWithinDirectory(filePath, basePath);
    }

    /**
     * Returns the content roots of the loaded project model.
     *
     * <p>Uses {@link ProjectRootManager#getContentRoots()}, so modules unloaded from the project
     * model are excluded. Returns an empty list when the project is disposed, the platform is
     * unavailable, or the project model cannot be read (for example in a unit test with a proxy
     * project).
     */
    public static @NotNull List<String> getContentRootPaths(@Nullable Project project) {
        if (project == null) {
            return List.of();
        }
        Application application = ApplicationManager.getApplication();
        if (application == null) {
            return List.of();
        }
        try {
            if (project.isDisposed()) {
                return List.of();
            }
            List<String> roots = application.runReadAction((Computable<List<String>>) () -> {
                List<String> paths = new ArrayList<>();
                for (VirtualFile root : ProjectRootManager.getInstance(project).getContentRoots()) {
                    paths.add(root.getPath());
                }
                return paths;
            });
            return roots == null ? List.of() : roots;
        } catch (ProcessCanceledException e) {
            throw e;
        } catch (Exception e) {
            LOG.debug("ProjectPathUtils: failed to read content roots: " + e.getMessage());
            return List.of();
        }
    }
}
