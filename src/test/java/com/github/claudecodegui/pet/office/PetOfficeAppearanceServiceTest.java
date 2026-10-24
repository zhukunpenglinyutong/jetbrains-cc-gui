package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.pet.CodexPetFloatingService.VisualConfiguration;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.*;

public class PetOfficeAppearanceServiceTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();
    private Path root;
    private AiDataProcessGate gate;
    private PetOfficeAppearanceService service;

    @Before public void setUp() throws Exception {
        root = temporary.newFolder("pets").toPath();
        gate = new AiDataProcessGate();
        service = new PetOfficeAppearanceService(root, gate::tryAcquireReadPermit);
    }
    private VisualConfiguration config(String id, long generation) {
        var defaults = PetOfficeAppearanceService.defaultConfiguration();
        return new VisualConfiguration(id, "project", 0.7, defaults.actionMappings(), generation);
    }
    private void image(String id, int color) throws Exception {
        BufferedImage image = new BufferedImage(8, 8, BufferedImage.TYPE_INT_ARGB);
        for (int x = 0; x < 8; x++) { for (int y = 0; y < 8; y++) { image.setRGB(x, y, color); } }
        assertTrue(ImageIO.write(image, "png", root.resolve(id).toFile()));
    }
    @Test public void builtinNeverTouchesTheDataGate() {
        service = new PetOfficeAppearanceService(root, () -> { throw new AssertionError("Unexpected read"); });
        assertEquals("BUILTIN", service.resolve(config("builtin", 0)).status());
        assertEquals("ASSET_UNAVAILABLE", service.resolve(null).status());
    }
    @Test public void bytesAreImmutableAndThePermitEndsBeforeTheSnapshotReturns() throws Exception {
        image("pet.png", 0xff11aaff);
        AtomicBoolean released = new AtomicBoolean();
        service = new PetOfficeAppearanceService(root, () -> {
            var read = gate.tryAcquireReadPermit();
            assertNull(gate.tryAcquireMigrationPermit());
            return () -> { read.close(); released.set(true); };
        });
        var appearance = service.resolve(config("pet.png", 0));
        assertEquals("READY", appearance.status()); assertTrue(released.get());
        assertEquals(0.7, appearance.opacity(), 0.001);
        byte[] bytes = service.bytes(appearance.manifest());
        assertEquals(appearance.manifest().digest(), PetOfficeAppearanceService.digest(bytes));
        bytes[0] = 0;
        assertNotEquals(0, service.bytes(appearance.manifest())[0]);
        try (var migration = gate.tryAcquireMigrationPermit()) { assertNotNull(migration); }
    }
    @Test public void sameFilenameReconfigurationInvalidatesEvenWithPreservedTimestamp() throws Exception {
        image("pet.png", 0xff11aaff);
        var first = service.resolve(config("pet.png", 0));
        FileTime timestamp = Files.getLastModifiedTime(root.resolve("pet.png"));
        image("pet.png", 0xffaa11ff); Files.setLastModifiedTime(root.resolve("pet.png"), timestamp);
        service.beginSnapshot(); var second = service.resolve(config("pet.png", 1));
        assertEquals("READY", second.status()); assertNotEquals(first.manifest().digest(), second.manifest().digest());
        assertNotEquals(first.revision(), second.revision());
    }
    @Test public void migrationBusyKeepsAdmittedArtAndNeverCancelsMigration() throws Exception {
        image("pet.png", 0xff11aaff);
        var first = service.resolve(config("pet.png", 0)); service.beginSnapshot();
        try (var migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
            var busy = service.resolve(config("pet.png", 0));
            assertEquals("ASSET_BUSY", busy.status()); assertEquals(first.manifest(), busy.manifest());
            assertFalse(migration.isCancellationRequested());
        }
    }
    @Test public void invalidMissingOversizeAndTraversalSelectionsFallBackWithoutExportingPaths() throws Exception {
        Files.write(root.resolve("bad.png"), new byte[]{1, 2, 3});
        Files.write(root.resolve("huge.png"), new byte[PetOfficeAppearanceService.MAX_IMAGE_BYTES + 1]);
        for (String id : new String[]{"../bad.png", "C:/bad.png", "missing.png", "bad.png", "huge.png", "folder/../bad.png"}) {
            var result = service.resolve(config(id, 0));
            assertEquals("ASSET_UNAVAILABLE", result.status()); assertEquals("builtin", result.manifest().kind());
            assertFalse(new com.google.gson.Gson().toJson(result).contains(id));
        }
    }
    @Test public void uniqueImagesRespectTheCacheAndNeverRemoveAnAcceptedSource() throws Exception {
        service.beginSnapshot();
        for (int i = 0; i < 9; i++) {
            String id = "pet-" + i + ".png"; image(id, 0xff000000 | i * 777);
            var result = service.resolve(config(id, 0));
            assertEquals(i < 8 ? "READY" : "ASSET_CAPACITY", result.status());
        }
        service.beginSnapshot(); assertEquals("READY", service.resolve(config("pet-8.png", 0)).status());
    }
    @Test public void unverifiedWindowsRootJunctionFailsClosed() throws Exception {
        org.junit.Assume.assumeTrue(System.getProperty("os.name").toLowerCase(java.util.Locale.ROOT).contains("windows"));
        image("pet.png", 0xff11aaff);
        Path link = temporary.getRoot().toPath().resolve("linked-pets");
        Process process = new ProcessBuilder("cmd.exe", "/d", "/c", "mklink", "/J", link.toString(), root.toString())
                .redirectErrorStream(true).start();
        try {
            assertTrue(process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
            var linked = new PetOfficeAppearanceService(link, gate::tryAcquireReadPermit);
            assertEquals("ASSET_UNAVAILABLE", linked.resolve(config("pet.png", 0)).status());
        } finally {
            process.destroyForcibly();
            Files.deleteIfExists(link);
        }
    }

    @Test public void relocationReleasesAllReadsBeforeCanonicalRootChangesAndRefreshesTheSameSelection() throws Exception {
        image("pet.png", 0xff22aaff);
        var canonical = new java.util.concurrent.atomic.AtomicReference<>(root);
        service = new PetOfficeAppearanceService(canonical::get, gate::tryAcquireReadPermit);
        var before = service.resolve(config("pet.png", 0));
        Path previous = root;
        try (var migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
            Path destination = previous.resolveSibling("moved-pets");
            Files.move(previous, destination); canonical.set(destination); root = destination;
            image("pet.png", 0xffaa2233);
            service.beginSnapshot(); var waiting = service.resolve(config("pet.png", 0));
            assertEquals("ASSET_BUSY", waiting.status()); assertEquals(before.manifest(), waiting.manifest());
            assertFalse(migration.isCancellationRequested());
        }
        service.beginSnapshot(); var after = service.resolve(config("pet.png", 0));
        assertEquals("READY", after.status()); assertNotEquals(before.manifest().digest(), after.manifest().digest());
        assertFalse(Files.exists(previous));
        assertEquals(after.manifest().digest(), PetOfficeAppearanceService.digest(service.bytes(after.manifest())));
    }
    @Test public void sessionSelectionsKeepInheritedSettingsImmutableAndUseTheExistingImageBoundary() throws Exception {
        image("a.png", 0xff11aaff); image("b.png", 0xffbb3311);
        var inherited = service.resolve(config("a.png", 0));
        var selected = service.resolveSession(inherited, "b.png", 0);
        assertEquals("session", selected.scope());
        assertEquals(inherited.opacity(), selected.opacity(), 0.001);
        assertEquals(inherited.actionMappings(), selected.actionMappings());
        assertNotEquals(inherited.manifest().digest(), selected.manifest().digest());
        assertEquals("project", inherited.scope());
        assertEquals(inherited, service.resolve(config("a.png", 0)));
        assertEquals("BUILTIN", service.resolveSession(inherited, "builtin", 0).status());
        assertEquals("ASSET_UNAVAILABLE", service.resolveSession(inherited, "missing.png", 0).status());
        assertThrows(IllegalArgumentException.class, () -> service.resolveSession(inherited, "../outside.png", 0));
    }

    @Test public void choicesAreBoundedRelativeIdsAndReleaseTheDataReadPermit() throws Exception {
        image("a.png", 0xff11aaff); Files.createDirectory(root.resolve("duck")); image("duck/spritesheet.png", 0xffbb3311);
        Files.writeString(root.resolve("private.txt"), "not an image");
        Files.createDirectory(root.resolve("nested")); Files.createDirectory(root.resolve("nested/deeper"));
        var choices = service.choices();
        assertEquals(java.util.List.of("builtin", "a.png", "duck/spritesheet.png"), choices.stream().map(PetOfficeAppearanceService.Choice::id).toList());
        assertEquals("duck", choices.get(2).label());
        try (var migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration); assertThrows(java.io.IOException.class, service::choices);
        }
        assertEquals(3, service.choices().size());
        assertNull(service.bytes(service.resolve(config("missing.png", 0)).manifest()));
    }

    @Test public void choicesUseTheSameUnicodeAliasAndDisplayNameAsThePetPicker() throws Exception {
        Files.createDirectory(root.resolve("pet-package-17")); image("pet-package-17/spritesheet.png", 0xff11aaff);
        Files.writeString(root.resolve("pet-package-17/pet.json"), "{\"alias\":\"  橘子  🐥  \",\"displayName\":\"Orange Duck\"}");
        assertEquals("橘子 🐥", service.choices().get(1).label());
        Files.writeString(root.resolve("pet-package-17/pet.json"), "{\"alias\":\"  \",\"displayName\":\"墨镜小鸭\"}");
        assertEquals("墨镜小鸭", service.choices().get(1).label());
        assertEquals("pet-package-17/spritesheet.png", service.choices().get(1).id());
    }

    @Test public void optionalInvalidOrOversizedMetadataDoesNotHideAPetOrExportItsFilePath() throws Exception {
        image("小机器人.png", 0xff11aaff);
        Path metadata = root.resolve("pet.json");
        for (String value : new String[]{"{", "[]", "{\"alias\":42}", "{\"displayName\":{}}", " ".repeat(65537)}) {
            Files.writeString(metadata, value);
            assertEquals("小机器人", service.choices().get(1).label());
        }
        Files.writeString(metadata, "{\"alias\":false,\"displayName\":\"Friendly Robot\"}");
        assertEquals("Friendly Robot", service.choices().get(1).label());
        try (var migration = gate.tryAcquireMigrationPermit()) { assertNotNull(migration); }
    }

    @Test public void petAliasesAreBoundedByCodePointsWithoutBreakingEmoji() throws Exception {
        image("pet.png", 0xff11aaff);
        Files.writeString(root.resolve("pet.json"), "{\"alias\":\"" + "🐥".repeat(80) + "\"}");
        String label = service.choices().get(1).label();
        assertEquals("🐥".repeat(60), label);
        assertEquals(60, label.codePointCount(0, label.length()));
    }

    @Test public void extensionOnlyImageNamesStillProduceANonEmptyCatalogLabel() throws Exception {
        image(".png", 0xff11aaff);
        assertEquals(".png", service.choices().get(1).label());
    }

}
