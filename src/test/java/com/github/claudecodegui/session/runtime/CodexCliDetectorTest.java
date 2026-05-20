package com.github.claudecodegui.session.runtime;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;

public class CodexCliDetectorTest {

    @Test
    public void prefersWindowsCmdShimWhenCommandIsAvailable() {
        List<String> command = new ArrayList<>();
        CodexCliAdapter.addCodexExecutable(command, "C:\\Tools\\codex.cmd");

        assertEquals(List.of("cmd", "/c", "C:\\Tools\\codex.cmd"), command);
    }

    @Test
    public void fallsBackToBareCodexNameWhenNoShimIsResolved() {
        List<String> command = new ArrayList<>();
        CodexCliAdapter.addCodexExecutable(command, null);

        assertEquals(List.of("codex"), command);
    }
}
