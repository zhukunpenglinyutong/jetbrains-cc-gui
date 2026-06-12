package com.github.claudecodegui.bridge;

import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.WslPathUtil;
import org.junit.Assume;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for WSL path utilities ({@link com.github.claudecodegui.util.WslPathUtil}).
 * Pure-function tests run on all platforms; tests that shell out to {@code wsl} are
 * gated by {@code Assume.assumeTrue(isWindows())} and run on the windows-latest CI job.
 */
public class NodeDetectorWslTest {

    // --- convertToWslPath ---

    @Test
    public void convertToWslPath_alreadyUnix_returnsAsIs() {
        assertEquals("/usr/bin/node", NodeDetector.convertToWslPath("/usr/bin/node"));
        assertEquals("/home/user/.nvm/versions/node/v20/bin/node",
                NodeDetector.convertToWslPath("/home/user/.nvm/versions/node/v20/bin/node"));
    }

    @Test
    public void convertToWslPath_driveLetter_convertsToPosixMount() {
        assertEquals("/mnt/c/Users/foo/bar", NodeDetector.convertToWslPath("C:\\Users\\foo\\bar"));
        assertEquals("/mnt/c/Program Files/nodejs/node.exe",
                NodeDetector.convertToWslPath("C:\\Program Files\\nodejs\\node.exe"));
        assertEquals("/mnt/d/projects/app", NodeDetector.convertToWslPath("D:\\projects\\app"));
    }

    @Test
    public void convertToWslPath_uncWslLocalhost_stripsPrefix() {
        assertEquals("/home/user/project",
                NodeDetector.convertToWslPath("\\\\wsl.localhost\\Ubuntu\\home\\user\\project"));
        assertEquals("/home/user",
                NodeDetector.convertToWslPath("\\\\wsl.localhost\\Ubuntu\\home\\user"));
    }

    @Test
    public void convertToWslPath_uncWslDollar_stripsPrefix() {
        assertEquals("/home/user/project",
                NodeDetector.convertToWslPath("\\\\wsl$\\Ubuntu\\home\\user\\project"));
    }

    @Test
    public void convertToWslPath_uncForwardSlashWsl_stripsPrefix() {
        // IntelliJ normalizes \\wsl.localhost\... to forward slashes in project.getBasePath()
        assertEquals("/home/gazoon007/wfi/jetbrains-cc-gui",
                NodeDetector.convertToWslPath("//wsl.localhost/Ubuntu/home/gazoon007/wfi/jetbrains-cc-gui"));
        assertEquals("/home/user",
                NodeDetector.convertToWslPath("//wsl$/Ubuntu/home/user"));
    }

    @Test
    public void convertToWslPath_nullOrEmpty_returnsInput() {
        assertEquals(null, NodeDetector.convertToWslPath(null));
        assertEquals("", NodeDetector.convertToWslPath(""));
    }

    @Test
    public void convertToWslPath_fallback_replacesBackslashes() {
        assertEquals("relative/path", NodeDetector.convertToWslPath("relative\\path"));
    }

    @Test
    public void convertToWslPath_driveLetterWithoutSeparator_insertsSeparator() {
        assertEquals("/mnt/c/Users/foo", NodeDetector.convertToWslPath("C:Users\\foo"));
        assertEquals("/mnt/d/", NodeDetector.convertToWslPath("D:"));
    }

    // --- isWslPath ---

    @Test
    public void isWslPath_nullOrEmpty_returnsFalse() {
        assertFalse(NodeDetector.isWslPath(null));
        assertFalse(NodeDetector.isWslPath(""));
    }

    @Test
    public void isWslPath_windowsPath_returnsFalse() {
        assertFalse(NodeDetector.isWslPath("C:\\Program Files\\nodejs\\node.exe"));
        assertFalse(NodeDetector.isWslPath("node"));
    }

    // --- buildNodeScriptCommand ---

    @Test
    public void buildNodeScriptCommand_nonWslPath_returnsNodeAndScript() {
        List<String> cmd = NodeDetector.buildNodeScriptCommand("node", "script.js");
        assertNotNull(cmd);
        assertEquals(2, cmd.size());
        assertEquals("node", cmd.get(0));
        assertEquals("script.js", cmd.get(1));
    }

    @Test
    public void buildNodeScriptCommand_returnsModifiableList() {
        List<String> cmd = NodeDetector.buildNodeScriptCommand("node", "script.js");
        cmd.add("extra-arg");
        assertEquals(3, cmd.size());
        assertEquals("extra-arg", cmd.get(2));
    }

    @Test
    public void buildNodeScriptCommand_windowsDrivePath_convertsScript() {
        List<String> cmd = NodeDetector.buildNodeScriptCommand(
                "C:\\Program Files\\nodejs\\node.exe",
                "C:\\Users\\foo\\script.js");
        assertNotNull(cmd);
        assertEquals(2, cmd.size());
        assertEquals("C:\\Program Files\\nodejs\\node.exe", cmd.get(0));
        assertEquals("C:\\Users\\foo\\script.js", cmd.get(1));
    }

    // --- buildNodeInlineCommand ---

    @Test
    public void buildNodeInlineCommand_nonWslPath_returnsNodeEvalScript() {
        List<String> cmd = NodeDetector.buildNodeInlineCommand("node", "console.log('hi');");
        assertNotNull(cmd);
        assertEquals(3, cmd.size());
        assertEquals("node", cmd.get(0));
        assertEquals("-e", cmd.get(1));
        assertEquals("console.log('hi');", cmd.get(2));
    }

    @Test
    public void buildNodeInlineCommand_windowsPath_doesNotPrependWsl() {
        List<String> cmd = NodeDetector.buildNodeInlineCommand(
                "C:\\Program Files\\nodejs\\node.exe", "console.log(1);");
        assertNotNull(cmd);
        assertEquals(3, cmd.size());
        assertEquals("C:\\Program Files\\nodejs\\node.exe", cmd.get(0));
        assertEquals("-e", cmd.get(1));
    }

    @Test
    public void buildNodeInlineCommand_returnsModifiableList() {
        List<String> cmd = NodeDetector.buildNodeInlineCommand("node", "1+1");
        cmd.add("extra");
        assertEquals(4, cmd.size());
    }

    // --- convertWslPathToWindowsUnc ---

    @Test
    public void convertWslPathToWindowsUnc_nullInput_returnsNull() {
        assertNull(NodeDetector.convertWslPathToWindowsUnc(null));
    }

    @Test
    public void convertWslPathToWindowsUnc_emptyInput_returnsNull() {
        assertNull(NodeDetector.convertWslPathToWindowsUnc(""));
    }

    @Test
    public void convertWslPathToWindowsUnc_relativePathNoLeadingSlash_returnsNull() {
        assertNull(NodeDetector.convertWslPathToWindowsUnc("home/user/file.js"));
    }

    @Test
    public void convertWslPathToWindowsUnc_onWindowsWithWsl_returnsUncPath() {
        Assume.assumeTrue("Skipped: not running on Windows", System.getProperty("os.name", "").toLowerCase().contains("windows"));

        String result = NodeDetector.convertWslPathToWindowsUnc("/home/gazoon007/file.js");
        Assume.assumeTrue("Skipped: WSL not available", result != null);

        assertTrue("UNC path must start with \\\\", result.startsWith("\\\\"));
        assertTrue("UNC path must contain the WSL path tail", result.endsWith("home\\gazoon007\\file.js"));
    }

    // --- resolveWslHomeUncPath (Windows+WSL only) ---

    @Test
    public void resolveWslHomeUncPath_onWindowsWithWsl_returnsAccessibleUncPath() {
        Assume.assumeTrue("Skipped: not running on Windows", System.getProperty("os.name", "").toLowerCase().contains("windows"));

        String uncPath = NodeDetector.resolveWslHomeUncPath();
        Assume.assumeTrue("Skipped: WSL not available or wslpath failed", uncPath != null && !uncPath.isEmpty());

        assertTrue("UNC path must start with \\\\", uncPath.startsWith("\\\\"));
        assertTrue("UNC path must be accessible via Files.exists()", Files.exists(Paths.get(uncPath)));
    }

    @Test
    public void resolveWslHomeUncPath_onWindowsWithWsl_isNotWindowsUserHome() {
        Assume.assumeTrue("Skipped: not running on Windows", System.getProperty("os.name", "").toLowerCase().contains("windows"));

        String uncPath = NodeDetector.resolveWslHomeUncPath();
        Assume.assumeTrue("Skipped: WSL not available", uncPath != null && !uncPath.isEmpty());

        String windowsHome = System.getenv("USERPROFILE");
        if (windowsHome != null) {
            assertFalse("WSL UNC home must differ from Windows USERPROFILE", uncPath.equalsIgnoreCase(windowsHome));
        }
        assertFalse("WSL UNC path must not contain a drive-letter root", uncPath.matches("(?i)[A-Z]:.*"));
    }

    // --- foldPosix ---

    @Test
    public void foldPosix_collapsesDotAndParentSegments() {
        assertEquals("/a/b", WslPathUtil.foldPosix("/a/b/c/.."));
        assertEquals("/a", WslPathUtil.foldPosix("/a/./b/.."));
        assertEquals("/etc/passwd", WslPathUtil.foldPosix("/Users/foo/project/../../../etc/passwd"));
    }

    @Test
    public void foldPosix_rootAndTrailingSlash() {
        assertEquals("/", WslPathUtil.foldPosix("/"));
        assertEquals("/a", WslPathUtil.foldPosix("/a/"));
        assertEquals("/", WslPathUtil.foldPosix("/a/.."));
    }

    @Test
    public void foldPosix_escapeAboveRoot_returnsNull() {
        assertNull(WslPathUtil.foldPosix("/.."));
        assertNull(WslPathUtil.foldPosix("/a/../.."));
    }

    @Test
    public void foldPosix_nonAbsoluteOrNull_returnsNull() {
        assertNull(WslPathUtil.foldPosix(null));
        assertNull(WslPathUtil.foldPosix(""));
        assertNull(WslPathUtil.foldPosix("relative/path"));
    }

    // --- isPathWithinDirectory ---

    @Test
    public void isPathWithinDirectory_parentTraversal_isRejected() {
        String base = "/Users/foo/project";
        assertFalse(NodeDetector.isPathWithinDirectory("/Users/foo/project/../../../etc/passwd", base));
        assertFalse(NodeDetector.isPathWithinDirectory("/Users/foo/project/sub/../../../etc/hosts", base));
    }

    @Test
    public void isPathWithinDirectory_legitChild_isAllowed() {
        String base = "/Users/foo/project";
        assertTrue(NodeDetector.isPathWithinDirectory("/Users/foo/project/legit.txt", base));
        assertTrue(NodeDetector.isPathWithinDirectory("/Users/foo/project/sub/dir/file.txt", base));
        assertTrue(NodeDetector.isPathWithinDirectory("/Users/foo/project", base));
    }

    @Test
    public void isPathWithinDirectory_siblingPrefix_isRejected() {
        assertFalse(NodeDetector.isPathWithinDirectory("/a/project-evil/file", "/a/project"));
    }

    @Test
    public void isPathWithinDirectory_nullInputs_returnFalse() {
        assertFalse(NodeDetector.isPathWithinDirectory(null, "/a"));
        assertFalse(NodeDetector.isPathWithinDirectory("", "/a"));
        assertFalse(NodeDetector.isPathWithinDirectory("/a/b", null));
    }

    // --- resolveHomeForFileOps ---

    @Test
    public void resolveHomeForFileOps_nativeNode_returnsOsHome() {
        String osHome = PlatformUtils.getHomeDirectory();
        assertEquals(osHome, NodeDetector.resolveHomeForFileOps("C:\\Program Files\\nodejs\\node.exe"));
        assertEquals(osHome, NodeDetector.resolveHomeForFileOps("node"));
        assertEquals(osHome, NodeDetector.resolveHomeForFileOps((String) null));
    }

    @Test
    public void resolveHomeForFileOps_nativeNode_onWindows_staysOnWindowsHome() {
        Assume.assumeTrue("Skipped: not running on Windows", System.getProperty("os.name", "").toLowerCase().contains("windows"));
        String home = NodeDetector.resolveHomeForFileOps("C:\\Program Files\\nodejs\\node.exe");
        assertEquals(PlatformUtils.getHomeDirectory(), home);
        assertFalse("Native node must not resolve into the WSL UNC home", home.startsWith("//"));
    }

    @Test
    public void resolveHomeForFileOps_wslNode_onWindows_returnsWslHome() {
        Assume.assumeTrue("Skipped: not running on Windows", System.getProperty("os.name", "").toLowerCase().contains("windows"));
        String unc = NodeDetector.resolveWslHomeUncPath();
        Assume.assumeTrue("Skipped: WSL not available", unc != null && !unc.isEmpty());

        String home = NodeDetector.resolveHomeForFileOps("/usr/bin/node");
        assertTrue("WSL node must resolve to the //wsl home", home.startsWith("//"));
        assertFalse("WSL home must not be a drive-letter path", home.matches("(?i)[A-Z]:.*"));
    }
}
