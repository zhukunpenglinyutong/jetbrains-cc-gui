package com.github.claudecodegui.pet.office;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class PetOfficeRuntimeLeaseTest {
    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void duplicateOpenRetainsOneOwnerAndReleaseDoesNotDeleteLockFile() throws Exception {
        Path directory = temporary.newFolder().toPath();
        try (PetOfficeRuntimeLease owner = PetOfficeRuntimeLease.tryAcquire(directory).orElseThrow()) {
            assertTrue(owner.isValid());
            assertFalse(PetOfficeRuntimeLease.tryAcquire(directory).isPresent());
        }
        assertTrue(Files.isRegularFile(directory.resolve("runtime.lock")));
        try (PetOfficeRuntimeLease next = PetOfficeRuntimeLease.tryAcquire(directory).orElseThrow()) {
            assertTrue(next.isValid());
        }
    }

    @Test(timeout = 30000)
    public void separateJvmsExcludeEachOtherAndCrashAllowsReacquisition() throws Exception {
        Path directory = temporary.newFolder().toPath();
        Process owner = start(directory, "hold");
        try {
            assertEquals("ACQUIRED", firstLine(owner));
            Process follower = start(directory, "try");
            try {
                assertTrue(follower.waitFor(10, TimeUnit.SECONDS));
                assertEquals("BUSY", firstLine(follower));
            } finally {
                follower.destroyForcibly();
            }
            // Only this owned fixture is stopped, never an installed IDE.
            owner.destroyForcibly();
            assertTrue(owner.waitFor(10, TimeUnit.SECONDS));
            Process successor = start(directory, "try");
            try {
                assertTrue(successor.waitFor(10, TimeUnit.SECONDS));
                assertEquals("ACQUIRED", firstLine(successor));
            } finally {
                successor.destroyForcibly();
            }
            assertTrue(Files.isRegularFile(directory.resolve("runtime.lock")));
        } finally {
            owner.destroyForcibly();
            owner.waitFor(10, TimeUnit.SECONDS);
        }
    }

    @Test
    public void unsafeLockEntryCannotCreateOwnership() throws Exception {
        Path directory = temporary.newFolder().toPath();
        Files.createDirectory(directory.resolve("runtime.lock"));
        try {
            PetOfficeRuntimeLease.tryAcquire(directory);
            fail("Directory lock entry must be rejected");
        } catch (IOException expected) {
            assertEquals("OFFICE_LOCK_INVALID", expected.getMessage());
        }
    }

    private static Process start(Path directory, String mode) throws Exception {
        String classpath = classLocation(PetOfficeLeaseProcess.class) + File.pathSeparator + classLocation(PetOfficeRuntimeLease.class);
        String executable = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        return new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", executable).toString(),
                "-cp", classpath, PetOfficeLeaseProcess.class.getName(), directory.toString(), mode).redirectError(ProcessBuilder.Redirect.DISCARD).start();
    }

    private static Path classLocation(Class<?> type) throws Exception {
        URL resource = type.getResource("/" + type.getName().replace('.', '/') + ".class");
        if (resource == null) {
            throw new IOException("Missing controlled process fixture");
        }
        if ("jar".equals(resource.getProtocol())) {
            String file = resource.getFile();
            int boundary = file.indexOf("!/");
            if (boundary < 0) {
                throw new IOException("Invalid controlled process fixture location");
            }
            return Path.of(URI.create(file.substring(0, boundary)));
        }
        Path location = Path.of(resource.toURI()).getParent();
        for (String ignored : type.getPackageName().split("\\.")) {
            location = location.getParent();
        }
        return location;
    }

    private static String firstLine(Process process) throws Exception {
        return new String(process.getInputStream().readNBytes(8), StandardCharsets.UTF_8).strip();
    }
}
