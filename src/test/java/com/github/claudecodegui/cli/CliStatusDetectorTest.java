package com.github.claudecodegui.cli;

import org.junit.Test;

import java.io.File;
import java.util.List;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

public class CliStatusDetectorTest {

    @Test
    public void envKeysFor_geminiExposesTheThreeOverrideKeys() {
        assertArrayEquals(
                new String[]{"GEMINI_BIN", "GEMINI_PATH", "GEMINI_CLI_PATH"},
                CliStatusDetector.envKeysFor(CliToolId.GEMINI)
        );
    }

    @Test
    public void envKeysFor_everyToolUsesBinPathCliPathConvention() {
        for (CliToolId tool : CliToolId.values()) {
            String[] keys = CliStatusDetector.envKeysFor(tool);
            String suffix = tool == CliToolId.GEMINI ? "GEMINI" : tool.getId().toUpperCase();
            assertEquals(tool + " first env key", suffix + "_BIN", keys[0]);
            assertEquals(tool + " second env key", suffix + "_PATH", keys[1]);
            assertEquals(tool + " third env key", suffix + "_CLI_PATH", keys[2]);
        }
    }

    @Test
    public void homeBinDirs_geminiLooksInLocalBin() {
        String home = "/home/test-user";
        List<String> dirs = CliStatusDetector.homeBinDirs(CliToolId.GEMINI, home);

        // Home candidate comes first (precedence over PATH-style fallback dirs,
        // which homeBinDirs also appends by design).
        String expected = new File(new File(home, ".local"), "bin").getAbsolutePath();
        assertEquals(expected, dirs.get(0));
        assertEquals(true, dirs.contains(expected));
    }

    @Test
    public void homeBinDirs_blankHomeYieldsNoDirs() {
        assertEquals(List.of(), CliStatusDetector.homeBinDirs(CliToolId.GEMINI, " "));
        assertEquals(List.of(), CliStatusDetector.homeBinDirs(CliToolId.GEMINI, null));
    }
}
