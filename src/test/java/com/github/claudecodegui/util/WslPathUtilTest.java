package com.github.claudecodegui.util;

import org.junit.Assume;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Comparator;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression coverage for {@link WslPathUtil#isPathWithinDirectory(String, String)}.
 * The project-boundary check gates auto-approval of edits, so on native POSIX systems it
 * MUST resolve symlinks via getCanonicalPath — a lexical-only check would let a symlink
 * inside the project escape the boundary and silently auto-approve writes outside it.
 */
public class WslPathUtilTest {

    @Test
    public void symlinkEscapingProjectIsRejectedOnNativePosix() throws IOException {
        Assume.assumeFalse("Symlink-resolving branch only applies to native POSIX paths",
                PlatformUtils.isWindows());

        Path root = Files.createTempDirectory("wslpathutil-test");
        try {
            Path project = Files.createDirectories(root.resolve("project"));
            Path outside = Files.createDirectories(root.resolve("outside"));
            Path secret = Files.write(outside.resolve("secret.txt"), new byte[]{1});

            Path escapeLink = project.resolve("link");
            try {
                Files.createSymbolicLink(escapeLink, outside);
            } catch (IOException | UnsupportedOperationException e) {
                Assume.assumeNoException("Filesystem does not support symlinks", e);
            }

            String reachedViaSymlink = escapeLink.resolve("secret.txt").toString();
            assertFalse(
                    "A file reached through a project-internal symlink pointing outside must not count as inside",
                    WslPathUtil.isPathWithinDirectory(reachedViaSymlink, project.toString()));
            // Sanity: the real target is genuinely outside the project.
            assertFalse(WslPathUtil.isPathWithinDirectory(secret.toString(), project.toString()));
        } finally {
            deleteRecursively(root);
        }
    }

    @Test
    public void fileGenuinelyInsideProjectIsAccepted() throws IOException {
        Assume.assumeFalse(PlatformUtils.isWindows());

        Path root = Files.createTempDirectory("wslpathutil-test");
        try {
            Path project = Files.createDirectories(root.resolve("project"));
            Path nested = Files.createDirectories(project.resolve("sub"));
            Path file = Files.write(nested.resolve("file.txt"), new byte[]{1});
            assertTrue(WslPathUtil.isPathWithinDirectory(file.toString(), project.toString()));
        } finally {
            deleteRecursively(root);
        }
    }

    @Test
    public void siblingDirectoryWithSharedPrefixIsRejected() throws IOException {
        Assume.assumeFalse(PlatformUtils.isWindows());

        Path root = Files.createTempDirectory("wslpathutil-test");
        try {
            Path project = Files.createDirectories(root.resolve("project"));
            Path sibling = Files.createDirectories(root.resolve("project-evil"));
            Path file = Files.write(sibling.resolve("file.txt"), new byte[]{1});
            assertFalse(WslPathUtil.isPathWithinDirectory(file.toString(), project.toString()));
        } finally {
            deleteRecursively(root);
        }
    }

    private static void deleteRecursively(Path path) throws IOException {
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        // Files.walk does not follow symlinks, so the escape link is removed as a link
        // (its target dir is cleaned up separately because it lives under the same root).
        try (var stream = Files.walk(path)) {
            stream.sorted(Comparator.reverseOrder()).forEach(p -> {
                try {
                    Files.deleteIfExists(p);
                } catch (IOException ignored) {
                    // best-effort cleanup
                }
            });
        }
    }
}
