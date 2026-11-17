package com.github.claudecodegui.util;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class ClaudeConfigDirTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private String home() {
        return tmp.getRoot().toPath().resolve("home").toString();
    }

    private String abs(String name) {
        return tmp.getRoot().toPath().resolve(name).toString();
    }

    @Test
    public void defaultsToDotClaudeUnderHome() {
        assertEquals(Paths.get(home(), ".claude"), ClaudeConfigDir.resolve(null, null, home()));
        assertNull(ClaudeConfigDir.explicit(null, null, home()));
    }

    @Test
    public void blankValuesAreTreatedAsUnset() {
        assertEquals(Paths.get(home(), ".claude"), ClaudeConfigDir.resolve("  ", "", home()));
        assertNull(ClaudeConfigDir.explicit("  ", "", home()));
    }

    @Test
    public void envVarReplacesDefault() {
        assertEquals(Paths.get(abs("cfg")), ClaudeConfigDir.resolve(null, abs("cfg"), home()));
    }

    @Test
    public void settingTakesPrecedenceOverEnvVar() {
        assertEquals(Paths.get(abs("a")), ClaudeConfigDir.resolve(abs("a"), abs("b"), home()));
    }

    @Test
    public void leadingTildeExpandsToHome() {
        Path expected = Paths.get(home(), ".claude-work");
        assertEquals(expected, ClaudeConfigDir.resolve("~/.claude-work", null, home()));
        assertEquals(expected, ClaudeConfigDir.resolve(null, "~\\.claude-work", home()));
        assertEquals(Paths.get(home()), ClaudeConfigDir.resolve("~", null, home()));
    }

    @Test
    public void valueIsTrimmed() {
        assertEquals(Paths.get(abs("a")), ClaudeConfigDir.resolve("  " + abs("a") + "  ", null, home()));
    }

    @Test
    public void relativeSettingIsIgnoredInFavourOfTheEnvVar() {
        assertEquals(Paths.get(abs("env")), ClaudeConfigDir.resolve("work/cfg", abs("env"), home()));
    }

    @Test
    public void relativeValuesEverywhereFallBackToTheDefault() {
        assertEquals(Paths.get(home(), ".claude"), ClaudeConfigDir.resolve("work/cfg", "other", home()));
        assertEquals(Paths.get(home(), ".claude"), ClaudeConfigDir.resolve("..", ".", home()));
        assertNull(ClaudeConfigDir.explicit("work/cfg", "other", home()));
    }

    @Test
    public void expandKeepsRelativePathsSoTheyCanBeRejectedByTheCaller() {
        assertEquals(Paths.get("work", "cfg"), ClaudeConfigDir.expand("work/cfg", home()));
    }

    @Test
    public void unusableValueIsTreatedAsUnset() {
        assertNull(ClaudeConfigDir.explicit("bad\0path", null, home()));
    }

    @Test
    public void wslNodeMapsALinuxPathThroughTheUncConverter() {
        String unc = abs("unc-home");
        assertEquals(Paths.get(unc), ClaudeConfigDir.resolve("/home/me/p", null, home(), true, linux -> unc));
    }

    @Test
    public void wslNodeEnvVarIsMappedToo() {
        String unc = abs("unc-env");
        assertEquals(Paths.get(unc), ClaudeConfigDir.resolve(null, "/home/me/p", home(), true, linux -> unc));
    }

    @Test
    public void unavailableWslMappingFallsThroughToTheNextCandidate() {
        assertEquals(Paths.get(abs("env")),
                ClaudeConfigDir.resolve("/home/me/p", abs("env"), home(), true, linux -> null));
        assertNull(ClaudeConfigDir.explicit("/home/me/p", null, home(), true, linux -> null));
    }

    @Test
    public void wslNodeStillExpandsTildeAgainstItsOwnHome() {
        assertEquals(Paths.get(home(), ".claude-work"),
                ClaudeConfigDir.resolve("~/.claude-work", null, home(), true, linux -> "unused"));
    }

    @Test
    public void wslNodeKeepsAnAbsoluteWindowsPathUnchanged() {
        assertEquals(Paths.get(abs("win")), ClaudeConfigDir.resolve(abs("win"), null, home(), true, linux -> "unused"));
    }

    @Test
    public void nativeNodeReceivesTheFilePathAsIs() {
        assertEquals(abs("x"), ClaudeConfigDir.forNode(Paths.get(abs("x")), false));
    }

    @Test
    public void wslNodeReceivesLinuxSpellings() {
        assertEquals("/home/me/p", ClaudeConfigDir.forNode(Paths.get("\\\\wsl.localhost\\Ubuntu\\home\\me\\p"), true));
        assertEquals("/mnt/d/x", ClaudeConfigDir.forNode(Paths.get("D:\\x"), true));
    }
}
