package com.github.claudecodegui.cli;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** Guard ZCode discovery across desktop client installation layouts. */
public class CliStatusDetectorZcodeTest {

    /** Keep filesystem fixtures independent of the host's installed bundle. */
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    /** Prefer the Linux package entry while preserving the legacy app subdirectory layout. */
    @Test
    public void findsLinuxPackageEntryBeforeLegacyLayout() {
        assertEquals(List.of(
                "/opt/ZCode/resources/glm/zcode.cjs",
                "/opt/ZCode/app/resources/glm/zcode.cjs"
        ), CliStatusDetector.zcodeAppBundleCandidates("linux", Map.of()));
    }

    /** Explicit paths take precedence over defaults, while blank overrides are ignored. */
    @Test
    public void letsExplicitEntriesLeadTheSearch() {
        assertEquals(List.of(
                "/custom/zcode.cjs",
                "/alternate/zcode.cjs",
                "/opt/ZCode/resources/glm/zcode.cjs",
                "/opt/ZCode/app/resources/glm/zcode.cjs"
        ), CliStatusDetector.zcodeAppBundleCandidates("linux", Map.of(
                "ZCODE_CLI_PATH", "  /custom/zcode.cjs  ",
                "ZCODE_PATH", "/alternate/zcode.cjs")));
        assertEquals(CliStatusDetector.zcodeAppBundleCandidates("linux", Map.of()),
                CliStatusDetector.zcodeAppBundleCandidates("linux", Map.of("ZCODE_CLI_PATH", "  ")));
    }

    /** The Linux path fix must not change macOS app bundle discovery. */
    @Test
    public void preservesMacAppBundleEntry() {
        assertEquals(List.of("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
                CliStatusDetector.zcodeAppBundleCandidates("darwin", Map.of()));
    }

    /** Preserve Windows per-user and both system-wide installation locations. */
    @Test
    public void preservesWindowsInstallLocations() {
        String local = Path.of("fixture", "local").toAbsolutePath().toString();
        String programs = Path.of("fixture", "programs").toAbsolutePath().toString();
        String programsX86 = Path.of("fixture", "programs-x86").toAbsolutePath().toString();
        assertEquals(List.of(
                Path.of(local, "Programs", "ZCode", "resources", "glm", "zcode.cjs").toString(),
                Path.of(programs, "ZCode", "resources", "glm", "zcode.cjs").toString(),
                Path.of(programsX86, "ZCode", "resources", "glm", "zcode.cjs").toString()
        ), CliStatusDetector.zcodeAppBundleCandidates("win32", Map.of(
                "LOCALAPPDATA", local, "ProgramFiles", programs, "ProgramFiles(x86)", programsX86)));
    }

    /** Missing Windows install roots must not fall back to Linux defaults. */
    @Test
    public void skipsMissingWindowsInstallRoots() {
        assertEquals(List.of(), CliStatusDetector.zcodeAppBundleCandidates("win32", Map.of("LOCALAPPDATA", "  ")));
    }

    /** A valid primary override must win without executing the fixture. */
    @Test
    public void prefersValidPrimaryEntryWithoutLaunchingIt() throws Exception {
        String entry = this.temporaryFolder.newFile("zcode.cjs").getAbsolutePath();
        String alternate = this.temporaryFolder.newFile("alternate.cjs").getAbsolutePath();
        CliToolStatus status = CliStatusDetector.detectZcodeAppBundle("win32", Map.of(
                "ZCODE_CLI_PATH", "  " + entry + "  ", "ZCODE_PATH", alternate));
        assertTrue(status.isInstalled());
        assertEquals("zcode", status.getId());
        assertEquals(entry, status.getPath());
        assertEquals("unknown", status.getVersion());
        assertNull(status.getError());
    }

    /** A broken primary override must not hide a valid alternate entry. */
    @Test
    public void triesAlternateAfterMissingOrDirectoryPrimary() throws Exception {
        String entry = this.temporaryFolder.newFile("zcode.cjs").getAbsolutePath();
        for (String primary : List.of(this.temporaryFolder.getRoot().getAbsolutePath(),
                new File(this.temporaryFolder.getRoot(), "missing.cjs").getAbsolutePath())) {
            CliToolStatus status = CliStatusDetector.detectZcodeAppBundle("win32", Map.of(
                    "ZCODE_CLI_PATH", primary, "ZCODE_PATH", "  " + entry + "  "));
            assertTrue(status.isInstalled());
            assertEquals(entry, status.getPath());
        }
    }

    /** Missing entries and directories must not masquerade as installed CLIs. */
    @Test
    public void rejectsMissingAndDirectoryOverrides() {
        for (String key : List.of("ZCODE_CLI_PATH", "ZCODE_PATH")) {
            for (String path : List.of(this.temporaryFolder.getRoot().getAbsolutePath(),
                    new File(this.temporaryFolder.getRoot(), "missing.cjs").getAbsolutePath())) {
                CliToolStatus status = CliStatusDetector.detectZcodeAppBundle("win32", Map.of(key, path));
                assertFalse(status.isInstalled());
                assertNull(status.getPath());
            }
        }
    }

    /** An invalid override must not block discovery of a valid desktop bundle. */
    @Test
    public void findsBundleAfterDirectoryOverride() throws Exception {
        File glm = this.temporaryFolder.newFolder("local", "Programs", "ZCode", "resources", "glm");
        Path entry = Files.createFile(glm.toPath().resolve("zcode.cjs"));
        String local = new File(this.temporaryFolder.getRoot(), "local").getAbsolutePath();
        CliToolStatus status = CliStatusDetector.detectZcodeAppBundle("win32", Map.of(
                "ZCODE_CLI_PATH", this.temporaryFolder.getRoot().getAbsolutePath(), "LOCALAPPDATA", local));
        assertTrue(status.isInstalled());
        assertEquals(entry.toString(), status.getPath());
    }

    /** Bundle entries need the same regular-file validation as explicit overrides. */
    @Test
    public void rejectsBundleDirectoryNamedLikeEntry() throws Exception {
        this.temporaryFolder.newFolder("local", "Programs", "ZCode", "resources", "glm", "zcode.cjs");
        String local = new File(this.temporaryFolder.getRoot(), "local").getAbsolutePath();
        CliToolStatus status = CliStatusDetector.detectZcodeAppBundle("win32", Map.of("LOCALAPPDATA", local));
        assertFalse(status.isInstalled());
        assertNull(status.getPath());
    }
}
