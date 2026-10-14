package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.github.claudecodegui.testing.TrackingProcessManager;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.util.ArrayList;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

/** Real OS children and disposable fault fixtures; no installed AI CLI is invoked. */
public class ClaudeHistoryProcessBoundaryTest {

    private static final String VALID_HISTORY = "{\"success\":true,\"messages\":["
            + "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"recovered marker\"}}]}";

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private Path home;
    private Path reply;
    private FixtureProcessManager manager;
    private ClaudeSessionQueryService service;

    @Before
    public void setUp() throws Exception {
        home = temporaryFolder.getRoot().toPath();
        reply = home.resolve("history-reply.json");
        Files.writeString(reply, VALID_HISTORY);
        NodeDetector.resetInstance();
        NodeDetector node = NodeDetector.getInstance();
        node.setNodeExecutable(javaExecutable());
        manager = new FixtureProcessManager();
        service = new ClaudeSessionQueryService(Logger.getInstance(getClass()), new Gson(), node,
                () -> home.toFile(), manager, new EnvironmentConfigurator(), new ClaudeJsonOutputExtractor()) {
            @Override
            Process startProcess(ProcessBuilder ignored) throws IOException {
                return manager.startFixtureProcess();
            }
        };
    }

    @After
    public void tearDown() {
        if (manager != null) {
            manager.cleanupAllProcesses();
        }
        NodeDetector.resetInstance();
    }

    @Test
    public void unavailableReaderDoesNotRegisterAChildAndTheRestoredReaderSucceeds() {
        manager.available = false;
        RuntimeException failure = assertThrows(RuntimeException.class,
                () -> service.getSessionMessages("fixture-session", home.toString()));
        assertTrue(failure.toString(), failure.getCause() instanceof IOException);
        assertEquals(0, manager.registerCalls.get());
        assertEquals(0, manager.getActiveProcessCount());
        manager.available = true;
        assertRecovered();
    }

    @Test
    public void malformedReplyDoesNotLeaveAChildAndValidRetrySucceeds() throws Exception {
        Files.writeString(reply, "{\"success\":true,\"messages\":[}");
        assertThrows(com.google.gson.JsonSyntaxException.class,
                () -> service.getSessionMessages("fixture-session", home.toString()));
        assertReleased(1);
        Files.writeString(reply, VALID_HISTORY);
        assertRecovered();
    }

    @Test
    public void missingHistoryIsClassifiedAndRestoredFileCanBeRead() throws Exception {
        Files.delete(reply);
        assertThrows(SessionHistoryNotFoundException.class,
                () -> service.getSessionMessages("fixture-session", home.toString()));
        assertReleased(1);
        Files.writeString(reply, VALID_HISTORY);
        assertRecovered();
    }

    @Test
    public void nativeWindowsReadDenialCanBeRemovedAndRetried() throws Exception {
        assumeTrue("Native Windows ACL fixture is required", System.getProperty("os.name").startsWith("Windows"));
        AclFileAttributeView view = Files.getFileAttributeView(reply, AclFileAttributeView.class);
        assertTrue("Windows fixture must expose ACLs", view != null);
        var original = view.getAcl();
        var currentUser = reply.getFileSystem().getUserPrincipalLookupService()
                .lookupPrincipalByName(System.getProperty("user.name"));
        var denied = new ArrayList<>(original);
        denied.add(0, AclEntry.newBuilder().setType(AclEntryType.DENY).setPrincipal(currentUser)
                .setPermissions(AclEntryPermission.READ_DATA).build());
        try {
            view.setAcl(denied);
            assertThrows(java.nio.file.AccessDeniedException.class, () -> Files.readString(reply));
            RuntimeException failure = assertThrows(RuntimeException.class,
                    () -> service.getSessionMessages("fixture-session", home.toString()));
            assertTrue(failure.toString(), failure.getMessage().contains("Permission denied"));
            assertReleased(1);
        } finally {
            view.setAcl(original);
        }
        assertRecovered();
    }

    @Test
    public void cancellingARealStalledChildTerminatesItAndAllowsRetry() throws Exception {
        manager.blocked = true;
        AtomicBoolean cancelled = new AtomicBoolean();
        CompletableFuture<Void> query = CompletableFuture.runAsync(() -> {
            assertThrows(CancellationException.class,
                    () -> service.getSessionMessages("fixture-session", home.toString(), cancelled::get));
        });
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
            while (!Files.exists(home.resolve("reader.ready")) && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            assertTrue("The real child must reach its blocked read", Files.exists(home.resolve("reader.ready")));
            assertTrue(manager.registeredProcess.get().isAlive());
            cancelled.set(true);
            query.get(10, TimeUnit.SECONDS);
            assertReleased(1);
        } finally {
            cancelled.set(true);
            manager.cleanupAllProcesses();
            query.get(10, TimeUnit.SECONDS);
        }
        manager.blocked = false;
        assertRecovered();
    }

    private void assertRecovered() {
        var history = service.getSessionMessages("fixture-session", home.toString());
        assertEquals(1, history.size());
        assertEquals("recovered marker", history.get(0).getAsJsonObject("message").get("content").getAsString());
        assertReleased(manager.registerCalls.get());
    }

    private void assertReleased(int count) {
        assertEquals(count, manager.registerCalls.get());
        assertEquals(count, manager.unregisterCalls.get());
        assertEquals(0, manager.getActiveProcessCount());
        assertFalse("The owned fixture process must exit", manager.registeredProcess.get().isAlive());
    }

    private static String javaExecutable() {
        return Path.of(System.getProperty("java.home"), "bin", "java").toString();
    }

    private final class FixtureProcessManager extends TrackingProcessManager {
        private boolean available = true;
        private boolean blocked;

        private Process startFixtureProcess() throws IOException {
            ProcessBuilder fixture;
            if (!available) {
                fixture = new ProcessBuilder(home.resolve("missing-history-reader.exe").toString());
            } else {
                Path source = Path.of("test", "ClaudeHistoryQueryFixture.java").toAbsolutePath();
                fixture = new ProcessBuilder(javaExecutable(), source.toString(), reply.toString());
                if (blocked) {
                    fixture.command().add(home.resolve("reader.ready").toString());
                }
            }
            return fixture.redirectErrorStream(true).start();
        }
    }
}
