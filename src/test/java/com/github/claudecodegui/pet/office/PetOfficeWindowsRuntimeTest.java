package com.github.claudecodegui.pet.office;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

public class PetOfficeWindowsRuntimeTest {
    @Test
    public void actualWindowsNamespaceIsStableLocalAndCurrentUserOnly() throws Exception {
        assumeTrue(System.getProperty("os.name").startsWith("Windows"));
        Path directory = PetOfficeWindowsRuntime.resolveDirectory();
        assertEquals(directory, PetOfficeWindowsRuntime.resolveDirectory());
        assertTrue(directory.startsWith(Path.of(System.getenv("LOCALAPPDATA")).toAbsolutePath().normalize()));
        assertTrue(directory.getFileName().toString().matches("desktop-[0-9a-f]{64}"));
        assertFalse(Files.isSymbolicLink(directory));
        AclFileAttributeView view = Files.getFileAttributeView(directory, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        assertFalse(view.getAcl().isEmpty());
        assertTrue(view.getAcl().stream().allMatch(entry -> entry.type() == AclEntryType.ALLOW && entry.principal().equals(viewOwner(directory))));
        Path probe = Files.createTempFile(directory, "g0-permissions-", ".probe");
        try {
            // Inspect inherited file permissions without competing with a running Office.
            AclFileAttributeView lockView = Files.getFileAttributeView(probe, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
            assertTrue(lockView.getAcl().stream().allMatch(entry -> entry.principal().equals(viewOwner(directory))));
        } finally {
            Files.deleteIfExists(probe);
        }
    }

    private static java.nio.file.attribute.UserPrincipal viewOwner(Path directory) {
        try {
            return Files.getOwner(directory, LinkOption.NOFOLLOW_LINKS);
        } catch (java.io.IOException failure) {
            throw new AssertionError(failure);
        }
    }
}
