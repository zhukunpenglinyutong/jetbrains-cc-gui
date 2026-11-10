package com.github.claudecodegui.util;

import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.progress.ProcessCanceledException;
import com.intellij.openapi.project.Project;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Proxy;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * Boundary rule: the project base and content roots form a union.
 */
public class ProjectPathUtilsTest {

    /** Keeps filesystem fixtures isolated from the repository. */
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    /** Accepts a content root outside the project base. */
    @Test
    public void acceptsContentRootOutsideTheProjectBase() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path attached = this.temporary.newFolder("attached").toPath();
        assertTrue(ProjectPathUtils.isWithinProjectBoundaries(
                attached.resolve("X.java").toString(), base.toString(), List.of(attached.toString())));
    }

    /** Accepts a path under the project base when content roots exist. */
    @Test
    public void acceptsBasePathWhenContentRootsExist() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path attached = this.temporary.newFolder("attached").toPath();
        assertTrue(ProjectPathUtils.isWithinProjectBoundaries(
                base.resolve("notes.md").toString(), base.toString(), List.of(attached.toString())));
    }

    /** Accepts the project base when no content root is available. */
    @Test
    public void acceptsTheProjectBaseWhenNoContentRootsAreAvailable() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path outside = this.temporary.newFolder("outside").toPath();
        assertTrue(ProjectPathUtils.isWithinProjectBoundaries(
                base.resolve("src/A.java").toString(), base.toString(), List.of()));
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                outside.resolve("A.java").toString(), base.toString(), List.of()));
    }

    /** Rejects a path outside both the base and every content root. */
    @Test
    public void rejectsPathOutsideBaseAndContentRoots() throws Exception {
        Path base = this.temporary.newFolder("base").toPath();
        Path attached = this.temporary.newFolder("attached").toPath();
        Path outside = this.temporary.newFolder("outside").toPath();
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                outside.resolve("A.java").toString(), base.toString(), List.of(attached.toString())));
    }

    /** Accepts a file under any of several content roots. */
    @Test
    public void acceptsAnyOfMultipleContentRoots() throws Exception {
        Path first = this.temporary.newFolder("first").toPath();
        Path second = this.temporary.newFolder("second").toPath();
        assertTrue(ProjectPathUtils.isWithinProjectBoundaries(
                second.resolve("B.java").toString(), null, List.of(first.toString(), second.toString())));
    }

    /** Fails closed when no boundary is available. */
    @Test
    public void rejectsWhenNoBoundaryIsAvailable() throws Exception {
        Path file = this.temporary.newFolder("file").toPath().resolve("A.java");
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(file.toString(), null, List.of()));
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries("", null, List.of()));
    }

    /** The public API fails closed for a null project or path. */
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

    /** Rejects a sibling that only shares the root's string prefix. */
    @Test
    public void rejectsSiblingPathSharingTheRootPrefix() throws Exception {
        Path root = this.temporary.newFolder("root").toPath();
        Path sibling = this.temporary.newFolder("root-other").toPath();
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                sibling.resolve("A.java").toString(), null, List.of(root.toString())));
    }

    /** Rejects traversal that escapes the content root. */
    @Test
    public void rejectsTraversalOutsideTheContentRoot() throws Exception {
        Path root = this.temporary.newFolder("root").toPath();
        Path outside = root.resolve("..").resolve("outside.ts");
        assertFalse(ProjectPathUtils.isWithinProjectBoundaries(
                outside.toString(), null, List.of(root.toString())));
    }

    /** Propagates platform cancellation instead of falling back to the base path. */
    @Test
    public void propagatesCancellationWhileReadingContentRoots() {
        Application previous = ApplicationManager.getApplication();
        Application application = (Application) Proxy.newProxyInstance(
                Application.class.getClassLoader(),
                new Class<?>[]{Application.class},
                (proxy, method, args) -> {
                    if ("runReadAction".equals(method.getName())) {
                        throw new ProcessCanceledException();
                    }
                    return method.getReturnType() == boolean.class ? false : null;
                });
        Project project = (Project) Proxy.newProxyInstance(
                Project.class.getClassLoader(),
                new Class<?>[]{Project.class},
                (proxy, method, args) -> switch (method.getName()) {
                    case "getBasePath" -> this.temporary.getRoot().getAbsolutePath();
                    case "isDisposed" -> false;
                    default -> null;
                });
        ApplicationManager.setApplication(application);
        try {
            assertThrows(ProcessCanceledException.class, () ->
                    ProjectPathUtils.isPathWithinProject(project, "A.java"));
        } finally {
            ApplicationManager.setApplication(previous);
        }
    }
}
