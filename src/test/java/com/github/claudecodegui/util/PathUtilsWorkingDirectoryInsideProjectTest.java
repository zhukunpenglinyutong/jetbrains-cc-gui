package com.github.claudecodegui.util;

import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class PathUtilsWorkingDirectoryInsideProjectTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private String project() throws IOException {
        return tmp.newFolder("project").getPath();
    }

    @Test
    public void theProjectItselfAndItsSubdirectoriesAreInside() throws IOException {
        String project = project();
        File nested = new File(project, "src" + File.separator + "deep");
        assertTrue(nested.mkdirs());

        assertTrue(PathUtils.isWorkingDirectoryInsideProject(project, project));
        assertTrue(PathUtils.isWorkingDirectoryInsideProject(nested.getPath(), project));
    }

    @Test
    public void aBlankWorkingDirectoryFallsBackToTheProject() throws IOException {
        String project = project();

        assertTrue(PathUtils.isWorkingDirectoryInsideProject(null, project));
        assertTrue(PathUtils.isWorkingDirectoryInsideProject("", project));
        assertTrue(PathUtils.isWorkingDirectoryInsideProject("undefined", project));
        assertTrue(PathUtils.isWorkingDirectoryInsideProject("null", project));
    }

    @Test
    public void aDirectoryOutsideTheProjectIsOutside() throws IOException {
        String project = project();
        String sibling = tmp.newFolder("project-other").getPath();

        assertFalse(PathUtils.isWorkingDirectoryInsideProject(sibling, project));
        assertFalse(PathUtils.isWorkingDirectoryInsideProject(tmp.getRoot().getPath(), project));
    }

    @Test
    public void dotDotSegmentsCannotLeaveTheProject() throws IOException {
        String project = project();
        tmp.newFolder("other");

        assertFalse(PathUtils.isWorkingDirectoryInsideProject(
                project + File.separator + ".." + File.separator + "other", project));
    }

    @Test
    public void aSymlinkInsideTheProjectThatPointsOutsideIsOutside() throws IOException {
        String project = project();
        Path outside = tmp.newFolder("outside").toPath();
        Path link = new File(project, "link").toPath();
        try {
            Files.createSymbolicLink(link, outside);
        } catch (UnsupportedOperationException | IOException | SecurityException error) {
            Assume.assumeNoException("symbolic links are unavailable", error);
        }

        assertFalse(PathUtils.isWorkingDirectoryInsideProject(link.toString(), project));
    }

    @Test
    public void withoutAProjectBaseNothingIsInside() {
        assertFalse(PathUtils.isWorkingDirectoryInsideProject("/work", null));
        assertFalse(PathUtils.isWorkingDirectoryInsideProject("/work", ""));
        assertFalse(PathUtils.isWorkingDirectoryInsideProject(null, null));
    }
}
