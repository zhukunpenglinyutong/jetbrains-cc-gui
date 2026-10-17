package com.github.claudecodegui.cli;

import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.dependency.SdkDefinition;
import com.github.claudecodegui.util.PlatformUtils;
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
import static org.junit.Assume.assumeFalse;

/** Guards Codex CLI detection: standalone installer layouts, version-proven installs and legacy vendor binaries. */
public class CliStatusDetectorCodexTest {
    /** Keeps path and probe tests independent of host installations. */
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    /** Codex is managed as a CLI only, never as an SDK install. */
    @Test
    public void codexIsACliAndCannotBeManagedAsAnSdk() {
        assertEquals(CliToolId.CODEX, CliToolId.fromId("codex"));
        assertNull(SdkDefinition.fromId("codex-sdk"));
        assertNull(SdkDefinition.fromProvider("codex"));
        assertFalse(new DependencyManager().isInstalled("codex-sdk"));
    }

    /** Preserves the binary paths of old installs for compatibility. */
    @Test
    public void preservesOfficialHoistedNestedAndLegacyVendorLayouts() {
        Path root = Path.of("fixture/node_modules");
        var candidates = CliStatusDetector.codexLegacyCandidates(root, "win32", "amd64");
        assertTrue(candidates.contains(root.resolve("@openai/codex/node_modules/@openai/codex-win32-x64"
                + "/vendor/x86_64-pc-windows-msvc/codex/codex.exe")));
        assertTrue(candidates.contains(root.resolve("@openai/codex-sdk/node_modules/@openai/codex-win32-x64"
                + "/vendor/x86_64-pc-windows-msvc/bin/codex.exe")));
        assertTrue(candidates.contains(root.resolve("@openai/codex-sdk/vendor/x86_64-pc-windows-msvc/codex/codex.exe")));
    }

    /** SDK metadata never counts as a CLI, and ARM must use its own platform binary. */
    @Test
    public void sdkMetadataIsNeverACliCandidateAndArmUsesItsOwnBinary() {
        var candidates = CliStatusDetector.codexLegacyCandidates(Path.of("fixture/node_modules"), "darwin", "aarch64");
        assertTrue(candidates.stream().anyMatch(path -> path.toString().replace('\\', '/')
                .endsWith("codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex")));
        assertFalse(candidates.stream().anyMatch(path -> path.toString().endsWith("package.json")
                || path.toString().endsWith(".installed")));
    }

    /** Both Unix installer entries and the old and new current layouts must be discoverable. */
    @Test
    public void followsStandaloneCurrentWithoutScanningUnselectedReleases() {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path current = home.resolve(".codex/packages/standalone/current");
        List<String> expected = List.of(home.resolve(".local/bin").toString(), current.resolve("bin").toString(),
                current.toString(), home.resolve(".cargo/bin").toString(), home.resolve(".codex/bin").toString());
        for (String platform : List.of("linux", "darwin")) {
            assertEquals(expected, CliStatusDetector.codexHomeBinDirs(home.toString(), platform, Map.of()));
        }
    }

    /** The Windows standalone installer exposes its entry under LOCALAPPDATA via a junction. */
    @Test
    public void findsWindowsStandaloneEntryEvenWithoutAnUpdatedPath() {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path localAppData = home.resolve("Local AppData");
        var dirs = CliStatusDetector.codexHomeBinDirs(home.toString(), "win32", Map.of("LOCALAPPDATA", localAppData.toString()));
        assertEquals(localAppData.resolve("Programs/OpenAI/Codex/bin").toString(), dirs.get(0));
        assertTrue(dirs.contains(home.resolve(".codex/packages/standalone/current/bin").toString()));
        assertTrue(dirs.contains(home.resolve(".codex/packages/standalone/current").toString()));
        assertEquals(home.resolve("AppData/Local/Programs/OpenAI/Codex/bin").toString(),
                CliStatusDetector.codexHomeBinDirs(home.toString(), "win32", Map.of()).get(0));
    }

    /** The data-home override must not move the default command entry, and the install dir alone is not a binary path. */
    @Test
    public void honorsInstallerEnvironmentWithoutConfusingHomeAndBinaryOverrides() {
        Path home = this.temporaryFolder.getRoot().toPath();
        Path data = home.resolve("Custom Codex Home");
        Path install = home.resolve("Custom Bin");
        var dirs = CliStatusDetector.codexHomeBinDirs(home.toString(), "linux",
                Map.of("CODEX_HOME", " " + data + " ", "CODEX_INSTALL_DIR", " " + install + " "));
        assertEquals(install.toString(), dirs.get(0));
        assertTrue(dirs.contains(home.resolve(".local/bin").toString()));
        assertTrue(dirs.contains(data.resolve("packages/standalone/current/bin").toString()));
        assertTrue(dirs.contains(data.resolve("packages/standalone/current").toString()));
        assertFalse(dirs.contains(home.resolve(".codex/packages/standalone/current/bin").toString()));
        assertEquals(CliStatusDetector.codexHomeBinDirs(home.toString(), "linux", Map.of()),
                CliStatusDetector.codexHomeBinDirs(home.toString(), "linux", Map.of("CODEX_HOME", " ", "CODEX_INSTALL_DIR", " ")));
    }

    /** Warnings before the version line must not hide the real version, and the native file needs no Node. */
    @Test
    public void recognizesCodexVersionAfterWarnings() throws Exception {
        assumeFalse(PlatformUtils.isWindows());
        String candidate = this.createProbe("WARNING: proceeding without updating PATH\ncodex-cli 0.163.0", 0);
        assertEquals("0.163.0", CliStatusDetector.probeCodexVersion(candidate));
    }

    /** An executable file or a fake version output must not mask a failed probe. */
    @Test
    public void rejectsFailedEmptyAndUnrelatedVersionProbes() throws Exception {
        assumeFalse(PlatformUtils.isWindows());
        assertNull(CliStatusDetector.probeCodexVersion(this.createProbe("codex-cli 0.163.0", 1)));
        assertNull(CliStatusDetector.probeCodexVersion(this.createProbe("", 0)));
        assertNull(CliStatusDetector.probeCodexVersion(this.createProbe("node v22.21.1", 0)));
        assertNull(CliStatusDetector.probeCodexVersion(this.createProbe("spawn codex ENOENT", 1)));
    }

    private String createProbe(String output, int exitCode) throws Exception {
        File file = this.temporaryFolder.newFile();
        Files.writeString(file.toPath(), "#!/bin/sh\n"
                + "if [ \"$#\" -ne 1 ] || [ \"$1\" != \"--version\" ]; then exit 99; fi\n"
                + "printf '%s\\n' '" + output.replace("'", "'\\''") + "'\nexit " + exitCode + "\n");
        assertTrue(file.setExecutable(true));
        return file.getAbsolutePath();
    }
}
