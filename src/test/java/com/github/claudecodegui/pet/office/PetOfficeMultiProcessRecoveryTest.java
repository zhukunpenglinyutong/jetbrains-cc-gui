package com.github.claudecodegui.pet.office;

import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
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
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

public class PetOfficeMultiProcessRecoveryTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void aSeparateJvmReceivesExactlyOneNavigationThroughTheAuthenticatedPublishingStream() throws Exception {
        Path root = privateRoot(); var registry = new PetOfficeParticipantRegistry();
        AtomicReference<PetOfficeTabNavigator.Result> result = new AtomicReference<>();
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow();
             var server = new PetOfficeIpcServer("host", registry, lease::isValid, () -> { })) {
            new PetOfficeEndpointStore(root).publish(server.endpoint(), lease);
            try (var peer = start(root, "participant")) {
                assertEquals("PUBLISHED", peer.line());
                var request = new PetOfficeTabNavigator.Request(UUID.randomUUID().toString(), "pycharm/tab-0/binding-0", "route-0", "");
                server.routes().submit("page", request, () -> true, result::set, System.nanoTime());
                assertEquals("ROUTED", peer.line());
                assertEquals(PetOfficeTabNavigator.Result.ATTENTION_REQUESTED, result.get());
                server.routes().submit("page", request, () -> true, result::set, System.nanoTime());
                assertEquals(PetOfficeTabNavigator.Result.UNAVAILABLE, result.get());
                assertEquals(1, registry.view("host", server.endpoint().leaderEpoch()).snapshot().sources().size());
            }
        }
    }

    @Test
    public void aLiveLeasePreventsTakeoverUntilDisposalAcknowledgementAndExplicitCloseDisablesRecovery() throws Exception {
        Path root = privateRoot();
        try (var owner = start(root, "explicit")) {
            assertEquals("SHOWN", owner.line());
            try (var follower = start(root, "recover")) { assertEquals("OCCUPIED", follower.line()); }
            owner.send("CLOSE"); assertEquals("CLOSING", owner.line());
            assertFalse(new PetOfficeRecoveryStore(root).read().enabled());
            assertFalse(PetOfficeRuntimeLease.tryAcquire(root).isPresent());
            owner.send("DISPOSED"); assertEquals("RELEASED", owner.line());
            assertTrue(owner.process.waitFor(10, TimeUnit.SECONDS));
        }
        try (var follower = start(root, "recover")) { assertEquals("DISABLED", follower.line()); }
        try (var lease = PetOfficeRuntimeLease.tryAcquire(root).orElseThrow()) { assertTrue(lease.isValid()); }
    }

    @Test
    public void controlledOwnerCrashReleasesTheOsLockAndPreservesHiddenIntentWithANewEndpointEpoch() throws Exception {
        Path root = privateRoot(); String previous;
        try (var owner = start(root, "explicit")) {
            assertEquals("SHOWN", owner.line());
            previous = new PetOfficeEndpointStore(root).read().leaderEpoch();
            owner.send("HIDE"); assertEquals("HIDDEN", owner.line());
            assertFalse(PetOfficeRuntimeLease.tryAcquire(root).isPresent());
            owner.close();
        }
        try (var successor = start(root, "recover")) {
            assertEquals("HIDDEN", successor.line());
            assertNotEquals(previous, new PetOfficeEndpointStore(root).read().leaderEpoch());
            assertTrue(new PetOfficeRecoveryStore(root).read().enabled());
            assertFalse(PetOfficeRuntimeLease.tryAcquire(root).isPresent());
            successor.send("DISPOSED"); assertEquals("RELEASED", successor.line());
        }
        assertNull(new PetOfficeEndpointStore(root).read());
    }

    private Path privateRoot() throws Exception {
        assumeTrue(System.getProperty("os.name").startsWith("Windows"));
        Path root = temporary.newFolder().toPath(); var owner = Files.getOwner(root, LinkOption.NOFOLLOW_LINKS);
        Files.getFileAttributeView(root, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS)
                .setAcl(List.of(AclEntry.newBuilder().setType(AclEntryType.ALLOW).setPrincipal(owner)
                        .setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)
                        .setPermissions(EnumSet.allOf(AclEntryPermission.class)).build()));
        return root;
    }

    private static Peer start(Path root, String mode) throws Exception {
        String classpath = classLocation(PetOfficeRoutingProcess.class) + File.pathSeparator
                + classLocation(PetOfficeRuntimeLease.class) + File.pathSeparator + classLocation(Gson.class);
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java.exe").toString(),
                "-cp", classpath, PetOfficeRoutingProcess.class.getName(), root.toString(), mode)
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        return new Peer(process);
    }

    private static Path classLocation(Class<?> type) throws Exception {
        URL resource = type.getResource("/" + type.getName().replace('.', '/') + ".class");
        if (resource == null) { throw new IOException("Missing controlled process fixture"); }
        if ("jar".equals(resource.getProtocol())) {
            String file = resource.getFile(); return Path.of(URI.create(file.substring(0, file.indexOf("!/"))));
        }
        Path location = Path.of(resource.toURI()).getParent();
        for (String ignored : type.getPackageName().split("\\.")) { location = location.getParent(); }
        return location;
    }

    private static final class Peer implements AutoCloseable {
        private final Process process;
        private final BufferedReader output;
        private Peer(Process process) {
            this.process = process;
            output = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        }
        private String line() throws Exception {
            var worker = Executors.newSingleThreadExecutor(task -> PetOfficeIpcServer.daemon(task, "Office fixture output"));
            try { return worker.submit(output::readLine).get(10, TimeUnit.SECONDS); }
            finally { worker.shutdownNow(); }
        }
        private void send(String command) throws IOException {
            process.getOutputStream().write((command + "\n").getBytes(StandardCharsets.UTF_8)); process.getOutputStream().flush();
        }
        @Override public void close() throws Exception {
            // This reference can only refer to a process created by start() in this test class.
            process.destroyForcibly(); assertTrue(process.waitFor(10, TimeUnit.SECONDS));
        }
    }
}
