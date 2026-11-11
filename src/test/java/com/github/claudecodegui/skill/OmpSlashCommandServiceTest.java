package com.github.claudecodegui.skill;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class OmpSlashCommandServiceTest {

    private static final String CWD = "/work/project";

    @Before
    public void setUp() {
        OmpSlashCommandService.clearCache();
    }

    @After
    public void tearDown() {
        OmpSlashCommandService.clearCache();
    }

    @Test
    public void parsesBridgeJsonIntoRegistryEntries() {
        String raw = "[DIAG-ENTRY] Provider: omp\n"
                + "{\"success\":true,\"commands\":["
                + "{\"name\":\"compact\",\"description\":\"Compact the session\",\"argumentHint\":\"[focus]\",\"source\":\"builtin\"},"
                + "{\"name\":\"/todo\",\"description\":\"Show todos\",\"argumentHint\":\"\",\"source\":\"builtin\"},"
                + "{\"name\":\"deploy\",\"description\":\"\",\"argumentHint\":\"<env>\",\"source\":\"skill\"},"
                + "{\"name\":\"bare\",\"source\":\"custom\"}"
                + "]}\n";

        List<SlashCommandRegistry.SlashCommand> commands =
                OmpSlashCommandService.parseBridgeOutput(raw).orElseThrow();

        assertEquals(List.of(
                new SlashCommandRegistry.SlashCommand("/compact", "Compact the session [focus]", "builtin"),
                new SlashCommandRegistry.SlashCommand("/todo", "Show todos", "builtin"),
                new SlashCommandRegistry.SlashCommand("/deploy", "<env>", "skill"),
                new SlashCommandRegistry.SlashCommand("/bare", "", "custom")
        ), commands);
    }

    @Test
    public void dropsNamelessEntriesAndKeepsFirstDuplicate() {
        String raw = "{\"success\":true,\"commands\":["
                + "{\"name\":\"session\",\"description\":\"first\",\"source\":\"builtin\"},"
                + "{\"name\":\"/session\",\"description\":\"second\",\"source\":\"skill\"},"
                + "{\"description\":\"no name\"},{\"name\":\"\"},{\"name\":\"/\"},{\"name\":7},\"junk\""
                + "]}";

        List<SlashCommandRegistry.SlashCommand> commands =
                OmpSlashCommandService.parseBridgeOutput(raw).orElseThrow();

        assertEquals(1, commands.size());
        assertEquals("/session", commands.get(0).name());
        assertEquals("first", commands.get(0).description());
    }

    @Test
    public void lastJsonLineWins() {
        String raw = "{\"success\":false,\"error\":\"old\",\"commands\":[]}\n"
                + "{\"success\":true,\"commands\":[{\"name\":\"todo\"}]}\n"
                + "trailing diagnostics\n";

        assertEquals(1, OmpSlashCommandService.parseBridgeOutput(raw).orElseThrow().size());
    }

    @Test
    public void failureOutputYieldsNoResult() {
        assertTrue(OmpSlashCommandService.parseBridgeOutput(
                "{\"success\":false,\"error\":\"OMP CLI not found\",\"commands\":[]}").isEmpty());
        assertTrue(OmpSlashCommandService.parseBridgeOutput("").isEmpty());
        assertTrue(OmpSlashCommandService.parseBridgeOutput(null).isEmpty());
        assertTrue(OmpSlashCommandService.parseBridgeOutput("not json at all").isEmpty());
        assertTrue(OmpSlashCommandService.parseBridgeOutput("{\"commands\":[{\"name\":\"x\"}]}").isEmpty());
    }

    @Test
    public void successWithoutCommandArrayIsAnEmptyCatalog() {
        Optional<List<SlashCommandRegistry.SlashCommand>> parsed =
                OmpSlashCommandService.parseBridgeOutput("{\"success\":true}");

        assertTrue(parsed.isPresent());
        assertTrue(parsed.get().isEmpty());
    }

    @Test
    public void ompListIsEmptyUntilFetchedAndNeverClaudeBuiltins() {
        List<SlashCommandRegistry.SlashCommand> commands = SlashCommandRegistry.getCommands("omp", CWD, null);

        assertTrue(commands.isEmpty());
        assertFalse(OmpSlashCommandService.hasCached(CWD));
    }

    @Test
    public void ompListComesFromCachePerWorkingDirectory() {
        List<SlashCommandRegistry.SlashCommand> cached = List.of(
                new SlashCommandRegistry.SlashCommand("/compact", "Compact", "builtin"));
        OmpSlashCommandService.putCached(CWD, cached);

        assertEquals(cached, SlashCommandRegistry.getCommands("omp", CWD, null));
        assertEquals(cached, SlashCommandRegistry.getCommands("OMP", CWD + " ", "/some/file.java"));
        assertTrue(SlashCommandRegistry.getCommands("omp", "/other/dir", null).isEmpty());
    }

    @Test
    public void otherProvidersIgnoreTheOmpCache() {
        OmpSlashCommandService.putCached(CWD, List.of(
                new SlashCommandRegistry.SlashCommand("/omp-only", "x", "builtin")));
        List<SlashCommandRegistry.SlashCommand> claude = SlashCommandRegistry.getCommands("claude", CWD, null);
        List<SlashCommandRegistry.SlashCommand> codex = SlashCommandRegistry.getCommands("codex", CWD, null);

        // Names, not records: a user skill of the same name legitimately overrides a built-in.
        assertTrue(names(claude).containsAll(names(SlashCommandRegistry.CLAUDE_BUILTIN)));
        assertTrue(names(codex).containsAll(names(SlashCommandRegistry.CODEX_BUILTIN)));
        assertTrue(claude.stream().noneMatch(c -> c.name().equals("/omp-only")));
        assertTrue(codex.stream().noneMatch(c -> c.name().equals("/omp-only")));
    }

    @Test
    public void cacheKeyNormalizesNullAndBlank() {
        assertEquals("", OmpSlashCommandService.cacheKey(null));
        assertEquals("", OmpSlashCommandService.cacheKey("  "));
        assertEquals(CWD, OmpSlashCommandService.cacheKey(" " + CWD + " "));
    }

    private static List<String> names(List<SlashCommandRegistry.SlashCommand> commands) {
        return commands.stream().map(SlashCommandRegistry.SlashCommand::name).toList();
    }
}
