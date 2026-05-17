package com.github.claudecodegui.bridge;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;

/**
 * Unit tests for NodeDetector WSL path utilities.
 * These are pure-function tests that do not require the IntelliJ Platform.
 */
public class NodeDetectorWslTest {

    // =========================================================================
    // convertToWslPath
    // =========================================================================

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
    public void convertToWslPath_nullOrEmpty_returnsInput() {
        assertEquals(null, NodeDetector.convertToWslPath(null));
        assertEquals("", NodeDetector.convertToWslPath(""));
    }

    @Test
    public void convertToWslPath_fallback_replacesBackslashes() {
        assertEquals("relative/path", NodeDetector.convertToWslPath("relative\\path"));
    }

    // =========================================================================
    // isWslPath  (always false on non-Windows; tested via static method contract)
    // =========================================================================

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

    // =========================================================================
    // buildNodeScriptCommand
    // =========================================================================

    @Test
    public void buildNodeScriptCommand_nonWslPath_returnsNodeAndScript() {
        List<String> cmd = NodeDetector.buildNodeScriptCommand(
                "/usr/local/bin/node", "/path/to/script.js");
        assertNotNull(cmd);
        assertEquals(2, cmd.size());
        assertEquals("/usr/local/bin/node", cmd.get(0));
        assertEquals("/path/to/script.js", cmd.get(1));
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
}
