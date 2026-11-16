package com.github.claudecodegui.util;

import org.junit.Test;

import java.nio.file.Paths;

import static org.junit.Assert.assertEquals;

public class ClaudeConfigDirTest {

    private static final String HOME = Paths.get("home", "user").toString();

    @Test
    public void defaultsToDotClaudeUnderHome() {
        assertEquals(Paths.get(HOME, ".claude"), ClaudeConfigDir.resolve(null, null, HOME));
    }

    @Test
    public void blankValuesAreTreatedAsUnset() {
        assertEquals(Paths.get(HOME, ".claude"), ClaudeConfigDir.resolve("  ", "", HOME));
    }

    @Test
    public void envVarReplacesDefault() {
        assertEquals(Paths.get("work", "cfg"), ClaudeConfigDir.resolve(null, "work/cfg", HOME));
    }

    @Test
    public void settingTakesPrecedenceOverEnvVar() {
        assertEquals(Paths.get("a"), ClaudeConfigDir.resolve("a", "b", HOME));
    }

    @Test
    public void leadingTildeExpandsToHome() {
        assertEquals(Paths.get(HOME, ".claude-work"), ClaudeConfigDir.resolve("~/.claude-work", null, HOME));
        assertEquals(Paths.get(HOME, ".claude-work"), ClaudeConfigDir.resolve(null, "~\\.claude-work", HOME));
    }

    @Test
    public void valueIsTrimmed() {
        assertEquals(Paths.get("a"), ClaudeConfigDir.resolve("  a  ", null, HOME));
    }
}
