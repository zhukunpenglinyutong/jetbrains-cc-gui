package com.github.claudecodegui.cli;

import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for version-manager bin-dir discovery in {@link CliStatusDetector}.
 * npm -g shims installed under nvm / fnm version dirs are invisible to a
 * GUI-launched IDE unless these roots are scanned directly.
 */
public class CliStatusDetectorVersionManagerTest {

    @Test
    public void versionManagerBinDirsScansNvmNewestFirst() throws Exception {
        File home = Files.createTempDirectory("cc-gui-vm-home").toFile();
        mkdirs(new File(home, ".nvm/versions/node/v22.22.3/bin"));
        mkdirs(new File(home, ".nvm/versions/node/v24.11.1/bin"));
        mkdirs(new File(home, ".nvm/versions/node/v9.11.2/bin"));

        List<String> dirs = CliStatusDetector.versionManagerBinDirs(home.getAbsolutePath());

        // Static single-node managers are always listed.
        assertTrue(dirs.contains(new File(home, ".hermes/node/bin").getAbsolutePath()));
        assertTrue(dirs.contains(new File(home, ".volta/bin").getAbsolutePath()));
        // Numeric (not lexicographic) descending order: v24 > v22 > v9.
        int i24 = dirs.indexOf(new File(home, ".nvm/versions/node/v24.11.1/bin").getAbsolutePath());
        int i22 = dirs.indexOf(new File(home, ".nvm/versions/node/v22.22.3/bin").getAbsolutePath());
        int i9 = dirs.indexOf(new File(home, ".nvm/versions/node/v9.11.2/bin").getAbsolutePath());
        assertTrue("all nvm version bin dirs must be listed", i24 != -1 && i22 != -1 && i9 != -1);
        assertTrue("newest nvm version must come first", i24 < i22 && i22 < i9);
    }

    @Test
    public void versionManagerBinDirsSkipsVersionDirsWithoutBinSubdir() throws Exception {
        File home = Files.createTempDirectory("cc-gui-vm-home").toFile();
        // Version dir exists but has no bin/ (partial install).
        mkdirs(new File(home, ".nvm/versions/node/v22.22.3/lib"));

        List<String> dirs = CliStatusDetector.versionManagerBinDirs(home.getAbsolutePath());

        assertFalse(dirs.contains(new File(home, ".nvm/versions/node/v22.22.3/bin").getAbsolutePath()));
    }

    @Test
    public void versionManagerBinDirsScansFnmInstallationLayout() throws Exception {
        File home = Files.createTempDirectory("cc-gui-vm-home").toFile();
        mkdirs(new File(home, ".local/share/fnm/node-versions/v20.1.0/installation/bin"));

        List<String> dirs = CliStatusDetector.versionManagerBinDirs(home.getAbsolutePath());

        assertTrue(dirs.contains(
                new File(home, ".local/share/fnm/node-versions/v20.1.0/installation/bin").getAbsolutePath()));
    }

    @Test
    public void versionManagerBinDirsHandlesBlankHome() {
        assertTrue(CliStatusDetector.versionManagerBinDirs("").isEmpty());
        assertTrue(CliStatusDetector.versionManagerBinDirs(null).isEmpty());
    }

    @Test
    public void compareVersionNamesDescOrdersNumericallyNotLexicographically() {
        // Lexicographic order would put "v9" after "v22"; numeric must not.
        assertTrue(CliStatusDetector.compareVersionNamesDesc("v9.11.2", "v22.0.0") > 0);
        assertTrue(CliStatusDetector.compareVersionNamesDesc("v24.11.1", "v22.22.3") < 0);
        assertEquals(0, CliStatusDetector.compareVersionNamesDesc("v22.22.3", "v22.22.3"));
    }

    private static void mkdirs(File dir) {
        assertTrue("failed to create " + dir, dir.mkdirs() || dir.isDirectory());
    }
}
