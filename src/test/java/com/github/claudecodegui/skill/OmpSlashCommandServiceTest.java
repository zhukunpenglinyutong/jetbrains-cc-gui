package com.github.claudecodegui.skill;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Function;
import java.util.function.Supplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class OmpSlashCommandServiceTest {

    private static final String CWD = "/work/project";

    private ScriptedBridge bridge;
    private AtomicLong clock;

    @Before
    public void setUp() {
        OmpSlashCommandService.clearCache();
        bridge = new ScriptedBridge();
        clock = new AtomicLong(1_000_000L);
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

    @Test
    public void failedFetchKeepsTheLastGoodList() {
        bridge.succeed("/compact", "/session");
        refresh(false);
        bridge.fail();

        List<SlashCommandRegistry.SlashCommand> afterFailure = refresh(false);

        assertEquals(List.of("/compact", "/session"), names(afterFailure));
        assertEquals(afterFailure, OmpSlashCommandService.getCached(CWD));
        assertEquals(afterFailure, SlashCommandRegistry.getCommands("omp", CWD, null));
    }

    @Test
    public void aLaterSuccessReplacesTheKeptList() {
        bridge.succeed("/old");
        refresh(false);
        bridge.fail();
        refresh(true);
        bridge.succeed("/new");
        refresh(true);

        assertEquals(List.of("/new"), names(OmpSlashCommandService.getCached(CWD)));
    }

    @Test
    public void directoryThatNeverHadAListStaysEmptyAfterFailure() {
        bridge.fail();

        assertTrue(refresh(false).isEmpty());
        assertTrue(OmpSlashCommandService.getCached(CWD).isEmpty());
        assertFalse(OmpSlashCommandService.hasCached(CWD));
    }

    @Test
    public void failureIsPerDirectory() {
        bridge.fail();
        refresh(false);
        bridge.succeed("/ok");

        List<SlashCommandRegistry.SlashCommand> other = OmpSlashCommandService.refresh(
                "/other/dir", false, bridge, clock::get, Runnable::run).join();

        assertEquals(List.of("/ok"), names(other));
        assertEquals(2, bridge.runs);
    }

    @Test
    public void automaticRefreshInsideTheBackoffSkipsTheBridgeAndShowsTheKeptList() {
        bridge.succeed("/compact");
        refresh(false);
        bridge.fail();
        clock.addAndGet(1_000L);
        refresh(false);
        assertEquals(2, bridge.runs);

        clock.addAndGet(OmpSlashCommandService.BACKOFF_MS[0] - 1);
        List<SlashCommandRegistry.SlashCommand> skipped = refresh(false);

        assertEquals(2, bridge.runs);
        assertEquals(List.of("/compact"), names(skipped));
    }

    @Test
    public void automaticRefreshAfterTheBackoffRunsTheBridgeAgain() {
        bridge.fail();
        refresh(false);
        clock.addAndGet(OmpSlashCommandService.BACKOFF_MS[0]);
        bridge.succeed("/compact");

        List<SlashCommandRegistry.SlashCommand> recovered = refresh(false);

        assertEquals(2, bridge.runs);
        assertEquals(List.of("/compact"), names(recovered));
    }

    @Test
    public void consecutiveFailuresWaitTwentySecondsThenAMinuteThenFiveMinutes() {
        long[] waits = {20_000L, 60_000L, 300_000L, 300_000L};
        int expectedRuns = 0;
        for (long wait : waits) {
            bridge.fail();
            refresh(false);
            expectedRuns++;
            assertEquals(expectedRuns, bridge.runs);

            clock.addAndGet(wait - 1);
            refresh(false);
            assertEquals("still backing off " + wait + "ms", expectedRuns, bridge.runs);

            clock.addAndGet(1);
        }
    }

    @Test
    public void aSuccessRestartsTheBackoffSequence() {
        bridge.fail();
        refresh(false);
        clock.addAndGet(20_000L);
        bridge.fail();
        refresh(false);
        clock.addAndGet(60_000L);
        bridge.succeed("/compact");
        refresh(false);
        bridge.fail();
        refresh(true);
        assertEquals(4, bridge.runs);

        clock.addAndGet(19_999L);
        refresh(false);
        assertEquals(4, bridge.runs);

        clock.addAndGet(1L);
        bridge.succeed("/compact");
        refresh(false);
        assertEquals(5, bridge.runs);
    }

    @Test
    public void userRequestedRefreshRunsInsideTheBackoff() {
        bridge.fail();
        refresh(false);
        bridge.succeed("/compact");

        List<SlashCommandRegistry.SlashCommand> commands = refresh(true);

        assertEquals(2, bridge.runs);
        assertEquals(List.of("/compact"), names(commands));
    }

    @Test
    public void failedUserRequestedRefreshStartsANewBackoff() {
        bridge.fail();
        refresh(false);
        clock.addAndGet(5_000L);
        bridge.fail();
        refresh(true);

        clock.addAndGet(OmpSlashCommandService.BACKOFF_MS[1] - 1);
        refresh(false);

        assertEquals(2, bridge.runs);
    }

    @Test
    public void bridgeCrashCountsAsFailureAndKeepsTheList() {
        bridge.succeed("/compact");
        refresh(false);
        bridge.crash();
        clock.addAndGet(OmpSlashCommandService.BACKOFF_MS[0]);

        List<SlashCommandRegistry.SlashCommand> afterCrash = refresh(false);
        refresh(false);

        assertEquals(List.of("/compact"), names(afterCrash));
        assertEquals(2, bridge.runs);
    }

    @Test
    public void concurrentRefreshesOfOneDirectoryShareOneFetch() {
        List<CompletableFuture<List<SlashCommandRegistry.SlashCommand>>> joined = new ArrayList<>();
        Function<String, Optional<List<SlashCommandRegistry.SlashCommand>>> reentrant = cwd -> {
            bridge.runs++;
            // Asked while the first fetch is still running.
            joined.add(OmpSlashCommandService.refresh(CWD, true, bridge, clock::get, Runnable::run));
            return Optional.of(List.of(new SlashCommandRegistry.SlashCommand("/compact", "", "builtin")));
        };

        CompletableFuture<List<SlashCommandRegistry.SlashCommand>> first =
                OmpSlashCommandService.refresh(CWD, false, reentrant, clock::get, Runnable::run);

        assertEquals(1, bridge.runs);
        assertEquals(1, joined.size());
        assertSame(first, joined.get(0));
    }

    private List<SlashCommandRegistry.SlashCommand> refresh(boolean userRequested) {
        return OmpSlashCommandService.refresh(CWD, userRequested, bridge, clock::get, Runnable::run).join();
    }

    /** Replays queued outcomes in order, counting how often the "bridge" was started. */
    private static final class ScriptedBridge
            implements Function<String, Optional<List<SlashCommandRegistry.SlashCommand>>> {
        private final Deque<Supplier<Optional<List<SlashCommandRegistry.SlashCommand>>>> outcomes =
                new ArrayDeque<>();
        private int runs;

        void succeed(String... names) {
            Optional<List<SlashCommandRegistry.SlashCommand>> commands = Optional.of(Arrays.stream(names)
                    .map(name -> new SlashCommandRegistry.SlashCommand(name, "", "builtin"))
                    .toList());
            outcomes.add(() -> commands);
        }

        void fail() {
            outcomes.add(Optional::empty);
        }

        void crash() {
            outcomes.add(() -> {
                throw new IllegalStateException("bridge exploded");
            });
        }

        @Override
        public Optional<List<SlashCommandRegistry.SlashCommand>> apply(String cwd) {
            runs++;
            return outcomes.removeFirst().get();
        }
    }

    private static List<String> names(List<SlashCommandRegistry.SlashCommand> commands) {
        return commands.stream().map(SlashCommandRegistry.SlashCommand::name).toList();
    }
}
