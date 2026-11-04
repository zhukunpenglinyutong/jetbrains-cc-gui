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
 * <p>A project's files live in module content roots, which may sit outside
 * {@link Project#getBasePath()} (for example directories attached as sibling
 * content roots). The loaded project model's content roots are authoritative:
 * a directory removed from the content roots is not project content just
 * because it sits under the project base. The base directory is only a
 * fallback when the content roots are unavailable.
 *
 * <p>项目边界判断：以已加载项目模型的 content roots 为准，允许附加在项目根之外的 content root。
 * 用户从 content roots 中移除的目录不再视为项目内容；仅在 content roots 不可用时才退回项目根目录。
 */
public final class ProjectPathUtils {

    private static final Logger LOG = Logger.getInstance(ProjectPathUtils.class);

    private ProjectPathUtils() {
    }

    /**
     * Returns true when {@code filePath} is inside a module content root.
     *
     * <p>Content roots are authoritative. The project base directory is used only when no
     * content root is available (for example while Gradle/Maven is still syncing, a module
     * has no content root, or a test uses a proxy project). A directory removed from the
     * content roots is therefore not treated as project content just because it sits under
     * the base directory.
     *
     * <p>Returns false when no boundary can be determined, so callers that gate writes fail closed.
     *
     * <p>当路径位于任意模块 content root 内时返回 true。content roots 是唯一权威边界；
     * 仅当没有任何 content root 可用（如 Gradle/Maven 同步中、模块没有 content root，
     * 或测试使用 proxy project）时才退回项目根。无法确定边界时返回 false，调用方的写操作保持失败关闭。
     */
    public static boolean isPathWithinProject(@Nullable Project project, @Nullable String filePath) {
        if (project == null || filePath == null || filePath.isEmpty()) {
            return false;
        }
        return isWithinProjectBoundaries(filePath, project.getBasePath(), getContentRootPaths(project));
    }

    /** Applies the boundary rule to already-collected roots. Visible for tests. / 对已收集的边界应用规则，测试可见。 */
    static boolean isWithinProjectBoundaries(
            @NotNull String filePath,
            @Nullable String basePath,
            @NotNull List<String> contentRoots
    ) {
        if (filePath.isEmpty()) {
            return false;
        }
        if (!contentRoots.isEmpty()) {
            for (String contentRoot : contentRoots) {
                if (WslPathUtil.isPathWithinDirectory(filePath, contentRoot)) {
                    return true;
                }
            }
            return false;
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
