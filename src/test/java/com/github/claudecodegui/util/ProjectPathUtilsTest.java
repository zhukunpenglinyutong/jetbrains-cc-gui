package com.github.claudecodegui.util;

import com.intellij.openapi.project.Project;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Boundary rule: content roots are authoritative; the project base is only a fallback.
 * 边界规则：content roots 优先；项目根目录仅在 content roots 不可用时兜底。
 */
public class ProjectPathUtilsTest {

    /** Keeps filesystem fixtures isolated from the repository. / 让测试文件与仓库隔离。 */
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    /** Accepts a content root outside the project base. / 接受位于项目根之外的 content root。 */
    @Test
    public void acceptsContentRootOutsideTheProjectBase() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path attached = this.temporary.newFolder("attached").toPath();
        assertTrue(ProjectPathUtils.isWithinProjectBoundaries(
                attached.resolve("X.java").toString(), base.toString(), List.of(attached.toString())));
    }

    /** Rejects a path under the project base when content roots exist. / content roots 存在时，base 下的路径应被拒绝。 */
    @Test
    public void rejectsBasePathWhenContentRootsExist() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path attached = this.temporary.newFolder("attached").toPath();
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                base.resolve("notes.md").toString(), base.toString(), List.of(attached.toString())));
    }

    /** Falls back to the project base when no content root is available. / content roots 为空时退回项目根判断。 */
    @Test
    public void fallsBackToTheProjectBaseWhenNoContentRootsAreAvailable() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path outside = this.temporary.newFolder("outside").toPath();
        assertTrue(ProjectPathUtils.isWithinProjectBoundaries(
                base.resolve("src/A.java").toString(), base.toString(), List.of()));
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                outside.resolve("A.java").toString(), base.toString(), List.of()));
    }

    /** Accepts a file under any of several content roots. / 命中任意一个 content root 即可。 */
    @Test
    public void acceptsAnyOfMultipleContentRoots() throws Exception {
        Path first = this.temporary.newFolder("first").toPath();
        Path second = this.temporary.newFolder("second").toPath();
        assertTrue(ProjectPathUtils.isWithinProjectBoundaries(
                second.resolve("B.java").toString(), null, List.of(first.toString(), second.toString())));
    }

    /** Fails closed when no boundary is available. / 没有可用边界时失败关闭。 */
    @Test
    public void rejectsWhenNoBoundaryIsAvailable() throws Exception {
        Path file = this.temporary.newFolder("file").toPath().resolve("A.java");
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(file.toString(), null, List.of()));
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries("", null, List.of()));
    }

    /** The public API fails closed for a null project or path. / 公共 API 对 null 项目和路径失败关闭。 */
    @Test
    public void rejectsNullProjectOrPath() {
        Project project = (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> null);
        assertFalse(ProjectPathUtils.isPathWithinProject(null, "X.java"));
        assertFalse(ProjectPathUtils.isPathWithinProject(project, null));
        assertFalse(ProjectPathUtils.isPathWithinProject(project, ""));
    }

    /** Rejects a sibling that only shares the root's string prefix. / 拒绝仅共享 root 字符串前缀的兄弟目录。 */
    @Test
    public void rejectsSiblingPathSharingTheRootPrefix() throws Exception {
        Path root = this.temporary.newFolder("root").toPath();
        Path sibling = this.temporary.newFolder("root-other").toPath();
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                sibling.resolve("A.java").toString(), null, List.of(root.toString())));
    }

    /** Rejects traversal that escapes the content root. / 拒绝通过 .. 逃逸 content root 的路径。 */
    @Test
    public void rejectsTraversalOutsideTheContentRoot() throws Exception {
        Path root = this.temporary.newFolder("root").toPath();
        Path outside = root.resolve("..").resolve("outside.ts");
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                outside.toString(), null, List.of(root.toString())));
    }
}
