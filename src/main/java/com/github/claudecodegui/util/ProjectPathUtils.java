package com.github.claudecodegui.util;

import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
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
 *
 * <p>项目边界判断：项目边界是项目根目录与已加载项目模型 content roots 的并集。
 * 接受附加在项目根之外的 content root，只会扩大原有 base 边界，不会收窄。
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
     *
     * <p>当路径位于项目根目录或任意已加载 content root 内时返回 true。项目边界是两者的并集：
     * content roots 用于扩展 base 边界，base 目录始终放行，即使它本身不是 content root。
     * 无法确定边界时返回 false，调用方的写操作保持失败关闭。
     */
    public static boolean isPathWithinProject(@Nullable Project project, @Nullable String filePath) {
        if (project == null || filePath == null || filePath.isEmpty()) {
            return false;
        }
        return isWithinProjectBoundaries(filePath, project.getBasePath(), getContentRootPaths(project));
    }

    /** Applies the base ∪ content-root boundary rule. Visible for tests. / 对已收集的边界应用 base ∪ content roots 规则，测试可见。 */
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
     *
     * <p>返回当前已加载项目模型中的 content roots。使用 getContentRoots()，因此被 unload 的模块
     * 不包含在内；项目已释放、平台不可用或项目模型无法读取（例如测试中的 proxy project）时返回空列表。
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
        } catch (Exception e) {
            LOG.debug("ProjectPathUtils: failed to read content roots: " + e.getMessage());
            return List.of();
        }
    }
}
