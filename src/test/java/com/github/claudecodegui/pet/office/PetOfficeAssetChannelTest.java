package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.pet.CodexPetFloatingService.VisualConfiguration;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.*;

public class PetOfficeAssetChannelTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();
    private Path root;
    private final AiDataProcessGate gate = new AiDataProcessGate();
    private final AtomicReference<PetOfficeSessionRegistry.CompleteSnapshot> snapshot = new AtomicReference<>();
    private final AtomicReference<VisualConfiguration> configuration = new AtomicReference<>();

    @Before public void setUp() throws Exception {
        root = temporary.newFolder().toPath();
        BufferedImage image = new BufferedImage(256, 256, BufferedImage.TYPE_INT_ARGB);
        java.util.Random random = new java.util.Random(13);
        for (int x = 0; x < 256; x++) { for (int y = 0; y < 256; y++) { image.setRGB(x, y, random.nextInt()); } }
        assertTrue(ImageIO.write(image, "png", root.resolve("pet.png").toFile()));
        snapshot.set(PetOfficeParticipantFixture.snapshot("idea", 3, 1, 1));
        configuration.set(config(0));
    }

    private VisualConfiguration config(long generation) {
        return new VisualConfiguration("pet.png", "project", 0.8, PetOfficeAppearanceService.defaultConfiguration().actionMappings(), generation);
    }
    private PetOfficeAppearancePublisher publisher() {
        return new PetOfficeAppearancePublisher(snapshot::get, ignored -> configuration.get(), new PetOfficeAppearanceService(root, gate::tryAcquireReadPermit));
    }
    private static String key(int index) { return "idea/tab-" + index + "/binding-" + index; }

    @Test public void authenticatedChunkedTransferReusesBytesWithoutExportingLocalSelections() throws Exception {
        try (var channel = new PetOfficeAssetChannel("idea", publisher())) {
            var catalog = PetOfficeAssetChannel.catalog(channel.endpoint(), "pycharm", () -> true);
            assertEquals(3, catalog.size());
            var appearance = catalog.get(key(0));
            assertEquals("READY", appearance.status());
            byte[] bytes = PetOfficeAssetChannel.asset(channel.endpoint(), "pycharm", key(0), appearance, () -> true);
            assertTrue(bytes.length > 32768);
            assertEquals(appearance.manifest().digest(), PetOfficeAppearanceService.digest(bytes));
            assertEquals(appearance.manifest(), catalog.get(key(2)).manifest());
            String encoded = new String(PetOfficeAppearanceCodec.encode(catalog, "idea"), java.nio.charset.StandardCharsets.UTF_8);
            assertFalse(encoded.contains(root.toString())); assertFalse(encoded.contains("pet.png"));
        }
    }

    @Test public void knowingTheDigestDoesNotAuthorizeAnotherSourceOrAnObsoleteGeneration() throws Exception {
        try (var channel = new PetOfficeAssetChannel("idea", publisher())) {
            var appearance = PetOfficeAssetChannel.catalog(channel.endpoint(), "pycharm", () -> true).get(key(0));
            assertThrows(IOException.class, () -> PetOfficeAssetChannel.asset(channel.endpoint(), "pycharm", "webstorm/tab-0/binding-0", appearance, () -> true));
            assertThrows(IOException.class, () -> PetOfficeAssetChannel.asset(channel.endpoint(), "pycharm", "idea/not-selected/binding-0", appearance, () -> true));
            configuration.set(config(1));
            assertThrows(IOException.class, () -> PetOfficeAssetChannel.asset(channel.endpoint(), "pycharm", key(0), appearance, () -> true));
            var next = PetOfficeAssetChannel.catalog(channel.endpoint(), "pycharm", () -> true).get(key(0));
            assertNotEquals(appearance.revision(), next.revision());
            assertEquals(appearance.manifest().digest(), next.manifest().digest());
            snapshot.set(PetOfficeParticipantFixture.snapshot("idea", 0, 2, 2));
            assertThrows(IOException.class, () -> PetOfficeAssetChannel.asset(channel.endpoint(), "pycharm", key(0), next, () -> true));
        }
    }

    @Test public void wrongAuthenticationCannotReadArtAndAClosedPageCannotCommitBytes() throws Exception {
        AtomicInteger reads = new AtomicInteger();
        var source = new PetOfficeAppearancePublisher(snapshot::get, ignored -> configuration.get(), new PetOfficeAppearanceService(root, () -> {
            reads.incrementAndGet(); return gate.tryAcquireReadPermit();
        }));
        try (var channel = new PetOfficeAssetChannel("idea", source)) {
            var e = channel.endpoint();
            var wrong = new PetOfficeEndpointStore.Endpoint(e.port(), e.leaderEpoch(), "0".repeat(64), e.ownerInstanceId());
            assertThrows(IOException.class, () -> PetOfficeAssetChannel.catalog(wrong, "pycharm", () -> true));
            assertEquals(0, reads.get());
            var appearance = PetOfficeAssetChannel.catalog(e, "pycharm", () -> true).get(key(0));
            assertThrows(IOException.class, () -> PetOfficeAssetChannel.asset(e, "pycharm", key(0), appearance, () -> false));
        }
    }

    @Test public void aBlockedImageReadDoesNotBlockControlHeartbeats() throws Exception {
        CountDownLatch entered = new CountDownLatch(1), release = new CountDownLatch(1);
        var source = new PetOfficeAppearancePublisher(snapshot::get, ignored -> configuration.get(), new PetOfficeAppearanceService(root, () -> {
            entered.countDown();
            try { if (!release.await(5, TimeUnit.SECONDS)) throw new IOException("test timeout"); }
            catch (InterruptedException stopped) { Thread.currentThread().interrupt(); throw new IOException(stopped); }
            return gate.tryAcquireReadPermit();
        }));
        var worker = Executors.newSingleThreadExecutor();
        try (var channel = new PetOfficeAssetChannel("idea", source);
             var control = new PetOfficeIpcServer("idea", new PetOfficeParticipantRegistry(), () -> true, () -> { });
             var client = new PetOfficeIpcClient(control.endpoint(), "pycharm")) {
            var art = worker.submit(() -> PetOfficeAssetChannel.catalog(channel.endpoint(), "pycharm", () -> true));
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            client.heartbeat();
            client.publish(PetOfficeParticipantFixture.snapshot("pycharm", 1, 1, 1));
            release.countDown();
            assertEquals(3, art.get(5, TimeUnit.SECONDS).size());
        } finally { release.countDown(); worker.shutdownNow(); }
    }

    @Test public void sharedBytesKeepProjectSpecificActionMappingsAndMigrationReadPermissions() throws Exception {
        var mappings = new java.util.HashMap<>(PetOfficeAppearanceService.defaultConfiguration().actionMappings());
        mappings.put("idle", java.util.List.of("waving"));
        var other = new VisualConfiguration("pet.png", "global", 0.4, Map.copyOf(mappings), 0);
        try (var source = new PetOfficeAppearancePublisher(snapshot::get,
                project -> project.endsWith("-0") ? configuration.get() : other, new PetOfficeAppearanceService(root, gate::tryAcquireReadPermit))) {
            var catalog = source.catalog();
            var first = catalog.get(key(0)); var second = catalog.get(key(2));
            assertEquals(first.manifest(), second.manifest());
            assertNotEquals(first.actionMappings(), second.actionMappings());
            assertNotEquals(first.opacity(), second.opacity(), 0.001);
            try (var migration = gate.tryAcquireMigrationPermit()) {
                assertNotNull(migration);
                assertEquals("ASSET_BUSY", source.catalog().get(key(0)).status());
                assertFalse(migration.isCancellationRequested());
            }
            var encoded = PetOfficeAppearanceCodec.encode(catalog, "idea");
            assertEquals(catalog, PetOfficeAppearanceCodec.decode(encoded, "idea"));
            assertThrows(IOException.class, () -> PetOfficeAppearanceCodec.decode(encoded, "foreign"));
        }
    }

    @Test public void disconnectDoesNotWaitForAnInProgressSourceRead() throws Exception {
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
        var source = new PetOfficeAppearancePublisher(snapshot::get, ignored -> configuration.get(), new PetOfficeAppearanceService(root, () -> {
            entered.countDown(); boolean interrupted = false;
            while (true) {
                try { if (release.await(5, TimeUnit.SECONDS)) break; throw new IOException("test timeout"); }
                catch (InterruptedException ignored) { interrupted = true; }
            }
            if (interrupted) Thread.currentThread().interrupt();
            return gate.tryAcquireReadPermit();
        }));
        var workers = Executors.newFixedThreadPool(2);
        try (var channel = new PetOfficeAssetChannel("idea", source)) {
            var reading = workers.submit(() -> {
                try { PetOfficeAssetChannel.catalog(channel.endpoint(), "pycharm", () -> true); return false; }
                catch (IOException expected) { return true; }
            });
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            workers.submit(channel::close).get(1, TimeUnit.SECONDS);
            release.countDown(); assertTrue(reading.get(5, TimeUnit.SECONDS));
        } finally { release.countDown(); workers.shutdownNow(); }
    }
}
