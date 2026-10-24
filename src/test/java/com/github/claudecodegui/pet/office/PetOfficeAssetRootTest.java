package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.pet.CodexPetFloatingService.VisualConfiguration;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.*;

public class PetOfficeAssetRootTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void plainCanonicalHomeNeedsNoMigrationMarker() throws Exception {
        Path home = temporary.newFolder("home").toPath();
        Path pets = Files.createDirectories(home.resolve(".codex/pets"));
        assertEquals(pets, PetOfficeAssetRoot.resolvePets(home));
    }

    @Test public void verifiedMigratedHomeLoadsTheFullSheetAndPreservesActions() throws Exception {
        windows();
        Path home = temporary.newFolder("home").toPath();
        Path physical = Files.createDirectories(temporary.newFolder("storage").toPath().resolve(".codex"));
        Path pets = Files.createDirectories(physical.resolve("pets/cat"));
        Files.writeString(physical.resolve(".cc-gui-storage"), "codex");
        BufferedImage sheet = new BufferedImage(1536, 1872, BufferedImage.TYPE_INT_ARGB);
        sheet.setRGB(0, 0, 0xff22aaff);
        assertTrue(ImageIO.write(sheet, "png", pets.resolve("spritesheet.png").toFile()));
        Path link = home.resolve(".codex");
        junction(link, physical);
        try {
            AiDataProcessGate gate = new AiDataProcessGate();
            var defaults = PetOfficeAppearanceService.defaultConfiguration();
            var config = new VisualConfiguration("cat/spritesheet.png", "global", 0.6, defaults.actionMappings(), 3);
            var service = new PetOfficeAppearanceService(() -> PetOfficeAssetRoot.resolvePets(home), gate::tryAcquireReadPermit);
            var appearance = service.resolve(config);
            assertEquals("READY", appearance.status());
            assertEquals("sheet", appearance.manifest().kind());
            assertEquals(1536, appearance.manifest().width());
            assertEquals(1872, appearance.manifest().height());
            assertEquals(defaults.actionMappings(), appearance.actionMappings());
            assertEquals("global", appearance.scope());
            assertEquals(0.6, appearance.opacity(), 0.001);
            assertArrayEquals(Files.readAllBytes(pets.resolve("spritesheet.png")), service.bytes(appearance.manifest()));
        } finally {
            Files.deleteIfExists(link);
        }
    }

    @Test public void linkedHomeRequiresTheCorrectBoundedMarker() throws Exception {
        windows();
        Path home = temporary.newFolder("home").toPath();
        Path physical = Files.createDirectories(temporary.newFolder("storage").toPath().resolve(".codex"));
        Path link = home.resolve(".codex");
        junction(link, physical);
        try {
            assertThrows(java.io.IOException.class, () -> PetOfficeAssetRoot.resolvePets(home));
            Path marker = physical.resolve(".cc-gui-storage");
            Files.writeString(marker, "claude");
            assertThrows(java.io.IOException.class, () -> PetOfficeAssetRoot.resolvePets(home));
            Files.writeString(marker, "codex" + " ".repeat(32));
            assertThrows(java.io.IOException.class, () -> PetOfficeAssetRoot.resolvePets(home));
        } finally {
            Files.deleteIfExists(link);
        }
    }

    @Test public void migratedRootDoesNotAdmitNestedPetJunctions() throws Exception {
        windows();
        Path home = temporary.newFolder("home").toPath();
        Path physical = Files.createDirectories(temporary.newFolder("storage").toPath().resolve(".codex"));
        Path pets = Files.createDirectories(physical.resolve("pets"));
        Files.writeString(physical.resolve(".cc-gui-storage"), "codex");
        Path outside = temporary.newFolder("outside").toPath();
        assertTrue(ImageIO.write(new BufferedImage(8, 8, BufferedImage.TYPE_INT_ARGB), "png", outside.resolve("pet.png").toFile()));
        Path homeLink = home.resolve(".codex");
        Path petLink = pets.resolve("linked");
        junction(homeLink, physical);
        try {
            junction(petLink, outside);
            try {
                var service = new PetOfficeAppearanceService(() -> PetOfficeAssetRoot.resolvePets(home), new AiDataProcessGate()::tryAcquireReadPermit);
                var defaults = PetOfficeAppearanceService.defaultConfiguration();
                var appearance = service.resolve(new VisualConfiguration("linked/pet.png", "project", 1, defaults.actionMappings(), 0));
                assertEquals("ASSET_UNAVAILABLE", appearance.status());
            } finally {
                Files.deleteIfExists(petLink);
            }
        } finally {
            Files.deleteIfExists(homeLink);
        }
    }

    @Test public void rootIsResolvedUnderThePermitAndRecheckedAfterReading() throws Exception {
        Path first = temporary.newFolder("first").toPath();
        Path second = temporary.newFolder("second").toPath();
        for (Path path : new Path[]{first, second}) {
            assertTrue(ImageIO.write(new BufferedImage(8, 8, BufferedImage.TYPE_INT_ARGB), "png", path.resolve("pet.png").toFile()));
        }
        AiDataProcessGate gate = new AiDataProcessGate();
        AtomicInteger resolutions = new AtomicInteger();
        var service = new PetOfficeAppearanceService(() -> {
            assertNull(gate.tryAcquireMigrationPermit());
            return resolutions.getAndIncrement() == 0 ? first : second;
        }, gate::tryAcquireReadPermit);
        var defaults = PetOfficeAppearanceService.defaultConfiguration();
        var appearance = service.resolve(new VisualConfiguration("pet.png", "project", 1, defaults.actionMappings(), 0));
        assertEquals("ASSET_UNAVAILABLE", appearance.status());
        assertEquals(2, resolutions.get());
        try (var migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
        }
    }

    private static void windows() {
        Assume.assumeTrue(System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("windows"));
    }

    private static void junction(Path link, Path target) throws Exception {
        Process process = new ProcessBuilder("cmd.exe", "/d", "/c", "mklink", "/J", link.toString(), target.toString()).redirectErrorStream(true).start();
        try {
            assertTrue(process.waitFor(10, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
        } finally {
            process.destroyForcibly();
        }
    }
}
