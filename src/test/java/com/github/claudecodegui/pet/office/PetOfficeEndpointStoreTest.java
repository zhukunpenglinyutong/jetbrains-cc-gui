package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.util.EnumSet;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

public class PetOfficeEndpointStoreTest {
    @Rule
    public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void atomicReplacementAndEpochFencedCleanupLeaveTheLeaseIntact() throws Exception {
        Path root = privateRoot();
        var store = new PetOfficeEndpointStore(root);
        assertNull(store.read());
        var first = endpoint();
        var next = endpoint();
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            store.publish(first, lease);
            assertEquals(first, store.read());
            store.publish(next, lease);
            store.removeOwned(first, lease);
            assertEquals(next, store.read());
            store.removeOwned(next, lease);
            assertNull(store.read());
            assertTrue(lease.isValid());
            assertFalse(PetOfficeRuntimeLease.tryAcquire(root).isPresent());
        }
        assertTrue(Files.isRegularFile(root.resolve("runtime.lock")));
        try (var children = Files.list(root)) {
            assertEquals(List.of("runtime.lock"), children.map(path -> path.getFileName().toString()).toList());
        }
    }

    @Test
    public void corruptOversizedNonFileAndForeignReadableEndpointsFailClosed() throws Exception {
        Path root = privateRoot();
        var store = new PetOfficeEndpointStore(root);
        Path file = root.resolve("coordinator-v1.json");
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            store.publish(endpoint(), lease);
            Files.writeString(file, "{\"schemaVersion\":1,\"schemaVersion\":1}", StandardCharsets.UTF_8);
            assertThrows(IOException.class, store::read);
            Files.writeString(file, " ".repeat(1025), StandardCharsets.UTF_8);
            assertThrows(IOException.class, store::read);
            store.publish(endpoint(), lease);
            AclFileAttributeView acl = Files.getFileAttributeView(file, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
            var original = acl.getAcl();
            var system = file.getFileSystem().getUserPrincipalLookupService().lookupPrincipalByName("NT AUTHORITY\\SYSTEM");
            assertNotEquals(Files.getOwner(root), system);
            acl.setAcl(List.of(original.get(0), AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(system)
                    .setPermissions(AclEntryPermission.READ_DATA).build()));
            try {
                assertThrows(IOException.class, store::read);
                assertThrows(IOException.class, () -> store.publish(endpoint(), lease));
            } finally {
                acl.setAcl(original);
            }
            Files.delete(file);
            Files.createDirectory(file);
            assertThrows(IOException.class, store::read);
        }
    }

    @Test
    public void aReleasedLeaseCannotPublishOrRemoveAnotherOwner() throws Exception {
        Path root = privateRoot();
        var store = new PetOfficeEndpointStore(root);
        var retired = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow();
        retired.close();
        try (var current = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) {
            var endpoint = endpoint();
            store.publish(endpoint, current);
            assertThrows(IOException.class, () -> store.publish(endpoint(), retired));
            store.removeOwned(endpoint, retired);
            assertEquals(endpoint, store.read());
        }
    }

    @Test(timeout = 60000)
    public void independentJvmParticipantsDiscoverOnePrivateEndpointAndShareItsRoster() throws Exception {
        Path root = privateRoot();
        var registry = new PetOfficeParticipantRegistry();
        AtomicInteger shows = new AtomicInteger();
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow();
             var server = new PetOfficeIpcServer("owner", registry, lease::isValid, shows::incrementAndGet)) {
            new PetOfficeEndpointStore(root).publish(server.endpoint(), lease);
            Process idea = start(root, "idea");
            Process pycharm = null;
            try {
                assertEquals("PUBLISHED", firstLine(idea));
                pycharm = start(root, "pycharm");
                assertEquals("PUBLISHED", firstLine(pycharm));
                assertEquals(2, shows.get());
                assertEquals(4, registry.view("owner", server.endpoint().leaderEpoch()).snapshot().sources().size());
                assertTrue(idea.isAlive()); assertTrue(pycharm.isAlive());
                assertFalse(PetOfficeRuntimeLease.tryAcquire(root).isPresent());
            } finally {
                stop(idea);
                if (pycharm != null) { stop(pycharm); }
            }
        }
    }

    private Path privateRoot() throws Exception {
        assumeTrue(System.getProperty("os.name").startsWith("Windows"));
        Path root = temporary.newFolder().toPath();
        var owner = Files.getOwner(root, LinkOption.NOFOLLOW_LINKS);
        var acl = Files.getFileAttributeView(root, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        acl.setAcl(List.of(AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(owner)
                .setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)
                .setPermissions(EnumSet.allOf(AclEntryPermission.class)).build()));
        return root;
    }

    private static PetOfficeEndpointStore.Endpoint endpoint() {
        return new PetOfficeEndpointStore.Endpoint(4242, UUID.randomUUID().toString(), "a".repeat(64), "owner");
    }

    private static Process start(Path root, String instance) throws Exception {
        String classpath = classLocation(PetOfficeParticipantProcess.class) + File.pathSeparator
                + classLocation(PetOfficeRuntimeLease.class) + File.pathSeparator + classLocation(Gson.class);
        return new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java.exe").toString(),
                "-cp", classpath, PetOfficeParticipantProcess.class.getName(), root.toString(), instance)
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
    }

    private static Path classLocation(Class<?> type) throws Exception {
        URL resource = type.getResource("/" + type.getName().replace('.', '/') + ".class");
        if (resource == null) { throw new IOException("Missing controlled process fixture"); }
        if ("jar".equals(resource.getProtocol())) {
            String file = resource.getFile();
            return Path.of(URI.create(file.substring(0, file.indexOf("!/"))));
        }
        Path location = Path.of(resource.toURI()).getParent();
        for (String ignored : type.getPackageName().split("\\.")) { location = location.getParent(); }
        return location;
    }

    private static String firstLine(Process process) throws Exception {
        var reader = Executors.newSingleThreadExecutor(task -> PetOfficeIpcServer.daemon(task, "Pet Office fixture output"));
        try {
            return reader.submit(() -> new String(process.getInputStream().readNBytes(10), StandardCharsets.UTF_8).strip()).get(10, TimeUnit.SECONDS);
        } finally {
            reader.shutdownNow();
        }
    }

    private static void stop(Process process) throws Exception {
        // Only processes created by this fixture are stopped; no installed IDE or Office is touched.
        process.destroyForcibly();
        assertTrue(process.waitFor(10, TimeUnit.SECONDS));
    }
}
