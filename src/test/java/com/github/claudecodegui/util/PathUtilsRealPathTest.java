package com.github.claudecodegui.util;

import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assume.assumeTrue;

public class PathUtilsRealPathTest {

    @Test
    public void resolvesSymlinkedProjectPathToPhysicalPath() throws IOException {
        Path realDir = Files.createTempDirectory("pathutils-realpath-real");
        Path linkPath = Paths.get(realDir + "-link");
        try {
            boolean linkCreated;
            try {
                Files.createSymbolicLink(linkPath, realDir);
                linkCreated = true;
            } catch (IOException | UnsupportedOperationException e) {
                linkCreated = false;
            }
            assumeTrue("filesystem refuses symlink creation", linkCreated);

            // The CLI keys session storage off the physical path, so the lookup side
            // must resolve the same way (issue #1789)
            assertEquals(realDir.toString(), PathUtils.realPath(linkPath.toString()));
        } finally {
            Files.deleteIfExists(linkPath);
            deleteRecursively(realDir);
        }
    }

    @Test
    public void nonexistentPathFallsBackToInput() {
        String ghost = Paths.get(System.getProperty("java.io.tmpdir"), "pathutils-realpath-ghost-nope").toString();
        assertEquals(ghost, PathUtils.realPath(ghost));
    }

    @Test
    public void nullAndEmptyReturnUnchanged() {
        assertNull(PathUtils.realPath(null));
        assertEquals("", PathUtils.realPath(""));
    }

    @Test
    public void wslUncPathIsReturnedUnchanged() {
        // JVM path parsing corrupts the //wsl prefix, so realPath must not touch it
        assertEquals("//wsl.localhost/Ubuntu/home/alice/proj",
                PathUtils.realPath("//wsl.localhost/Ubuntu/home/alice/proj"));
        assertEquals("//wsl$/Ubuntu/home/alice/proj",
                PathUtils.realPath("//wsl$/Ubuntu/home/alice/proj"));
    }

    private static void deleteRecursively(Path dir) throws IOException {
        if (!Files.exists(dir)) {
            return;
        }
        try (java.util.stream.Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(java.util.Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
        }
    }
}
