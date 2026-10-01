package com.github.claudecodegui.agent;

import com.github.claudecodegui.agent.AgentDenyRules.DenyIndex;
import com.github.claudecodegui.agent.AgentResolver.Resolution;
import com.github.claudecodegui.agent.SubagentDiscoveryScanner.ScanResult;
import com.github.claudecodegui.model.AgentFields;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * Behaviour tests for {@link AgentResolver} (task 59, PRD R9 / R11 / R8).
 *
 * <p>Three groups of evidence are pinned here.
 *
 * <ol>
 *   <li><b>Precedence (R9, AC2)</b> — for one name present in several sources
 *       the project definition wins over the global one, which wins over the
 *       store, and the winner is taken <em>whole</em>: a field the loser
 *       happened to define never leaks into the winning entry.</li>
 *   <li><b>Scope selection (R11)</b> — the client may ask for named scopes, and a
 *       request without a body still means "everything", because the chat-bar
 *       provider has been sending an empty body since before this contract
 *       existed.</li>
 *   <li><b>Deny marking (R8, AC5)</b> — an agent named in
 *       {@code permissions.deny} is flagged, an agent that is not named is not,
 *       and a deny rule that matches no known agent is reported rather than
 *       silently swallowed.</li>
 * </ol>
 *
 * <p>Every directory used here is a {@link TemporaryFolder}. The developer's
 * real {@code ~/.claude} is never scanned, opened, or written to.
 */
public class AgentResolverTest {

    /** A complete, minimal agent file. */
    private static final String AGENT_FILE = String.join("\n",
            "---",
            "name: {name}",
            "description: The {name} agent",
            "model: sonnet",
            "---",
            "You are {name}.",
            "");

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    // ==================================================================
    // 1. Precedence (R9)
    // ==================================================================

    /**
     * AC2: the project definition shadows the global one. The entry that comes
     * back is the project file, whole — its own id, its own scope, its own
     * fields.
     */
    @Test
    public void localBeatsGlobalAndStoreForTheSameName() throws IOException {
        Path globalRoot = agentsRoot("global-root");
        Path localRoot = agentsRoot("local-root");
        write(globalRoot.resolve("code-reviewer.md"), AGENT_FILE.replace("{name}", "code-reviewer"));
        write(localRoot.resolve("code-reviewer.md"), AGENT_FILE.replace("{name}", "code-reviewer"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("code-reviewer", "an imported copy")),
                scan(globalRoot, AgentFields.SCOPE_GLOBAL, localRoot, AgentFields.SCOPE_LOCAL),
                DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        assertEquals(List.of("code-reviewer"), names(resolution));
        JsonObject winner = resolution.agents().get(0);
        assertEquals(AgentFields.SCOPE_LOCAL, winner.get("scope").getAsString());
        assertEquals("local-code-reviewer", winner.get("id").getAsString());
        assertTrue("the winner is a file-backed agent",
                winner.get("readOnly").getAsBoolean());
    }

    /**
     * The load-bearing part of R9: a loser never contributes a field. Here the
     * store copy carries a {@code prompt} and a {@code createdAt}, the global
     * file carries a {@code description}; neither survives in the winner.
     *
     * <p>Field-level merging was rejected because a subagent is a single
     * definition with a single contract. A half-merged agent would advertise a
     * body it does not have, or a model its file never declared, and the
     * plugin could not say which file it would have to be written back to —
     * except that file-backed agents are read-only and never written back at
     * all. Wholesale replacement is also the only rule a user can predict:
     * "the nearest definition wins", with no notion of a partial shadow.
     */
    @Test
    public void theWinnerIsTakenWholeAndIsNotCompletedFromTheLosers() throws IOException {
        Path globalRoot = agentsRoot("g");
        Path localRoot = agentsRoot("l");
        write(localRoot.resolve("reviewer.md"), AGENT_FILE.replace("{name}", "reviewer"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("reviewer", "an imported copy")),
                scan(globalRoot, AgentFields.SCOPE_GLOBAL, localRoot, AgentFields.SCOPE_LOCAL),
                DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        JsonObject winner = resolution.agents().get(0);
        assertEquals(1, resolution.agents().size());
        assertEquals(AgentFields.SCOPE_LOCAL, winner.get("scope").getAsString());
        assertFalse("no field may come from the store copy",
                winner.has("prompt"));
        assertFalse(winner.has("createdAt"));
        assertEquals("The reviewer agent", winner.get("description").getAsString());
    }

    /** The global file shadows the store when no project file exists. */
    @Test
    public void globalBeatsStore() throws IOException {
        Path globalRoot = agentsRoot("g");
        write(globalRoot.resolve("reviewer.md"), AGENT_FILE.replace("{name}", "reviewer"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("reviewer", "an imported copy")),
                scan(globalRoot, AgentFields.SCOPE_GLOBAL),
                DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        assertEquals(1, resolution.agents().size());
        JsonObject winner = resolution.agents().get(0);
        assertEquals(AgentFields.SCOPE_GLOBAL, winner.get("scope").getAsString());
        assertEquals("global-reviewer", winner.get("id").getAsString());
        assertFalse(winner.has("prompt"));
    }

    /** A store entry is the last resort, and it keeps the shape the store gave it. */
    @Test
    public void storeEntrySurvivesWhenNoFileDefinesTheName() throws IOException {
        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("only-in-store", "a prompt")),
                ScanResult.empty(), DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        assertEquals(1, resolution.agents().size());
        JsonObject agent = resolution.agents().get(0);
        assertEquals(AgentFields.SCOPE_STORE, agent.get("scope").getAsString());
        assertEquals("a prompt", agent.get("prompt").getAsString());
        assertFalse(agent.get("readOnly").getAsBoolean());
    }

    /**
     * Distinct names do not shadow each other: all three sources are visible at
     * once, each tagged with the scope it actually came from. Precedence is
     * keyed by name, not a whole-source replacement.
     */
    @Test
    public void distinctNamesFromAllThreeSourcesAreAllPresent() throws IOException {
        Path globalRoot = agentsRoot("g");
        Path localRoot = agentsRoot("l");
        write(globalRoot.resolve("g-one.md"), AGENT_FILE.replace("{name}", "g-one"));
        write(localRoot.resolve("l-one.md"), AGENT_FILE.replace("{name}", "l-one"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("s-one", "a prompt")),
                scan(globalRoot, AgentFields.SCOPE_GLOBAL, localRoot, AgentFields.SCOPE_LOCAL),
                DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        assertEquals(3, resolution.agents().size());
        assertEquals(List.of("g-one", "l-one", "s-one"), names(resolution));
        assertEquals(Set.of(AgentFields.SCOPE_GLOBAL, AgentFields.SCOPE_LOCAL,
                AgentFields.SCOPE_STORE), scopes(resolution));
    }

    /**
     * A store entry written before the scope existed carries no {@code scope}.
     * It is a store entry — that is the only thing it can be — and must not be
     * dropped or mislabelled.
     */
    @Test
    public void treatsALegacyStoreEntryWithoutScopeAsStoreScope() throws IOException {
        JsonObject legacy = new JsonObject();
        legacy.addProperty("id", "abc");
        legacy.addProperty("name", "legacy");
        legacy.addProperty("prompt", "hello");

        Resolution resolution = AgentResolver.resolve(
                List.of(legacy), ScanResult.empty(), DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        assertEquals(1, resolution.agents().size());
        JsonObject agent = resolution.agents().get(0);
        assertEquals(AgentFields.SCOPE_STORE, agent.get("scope").getAsString());
        assertEquals(AgentFields.SCOPE_STORE, agent.get("source").getAsString());
        assertFalse(agent.get("readOnly").getAsBoolean());
    }

    /**
     * Names are shadowed exactly, the same rule the deny reader uses: a
     * case-insensitive match would shadow two genuinely different agents from
     * unrelated projects, and the user would see one of them disappear.
     */
    @Test
    public void shadowsOnlyOnAnExactNameMatch() throws IOException {
        Path localRoot = agentsRoot("l");
        write(localRoot.resolve("Reviewer.md"), AGENT_FILE.replace("{name}", "Reviewer"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("reviewer", "a prompt")),
                scan(localRoot, AgentFields.SCOPE_LOCAL),
                DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        assertEquals(2, resolution.agents().size());
    }

    // ==================================================================
    // 2. Scope selection (R11)
    // ==================================================================

    /**
     * The chat-bar provider calls {@code get_agents} with an empty body, and
     * the settings tab called it the same way before this task. An absent,
     * empty or unparsable body must therefore mean "every scope" — the whole
     * point of the default is that no client has to be upgraded to keep
     * working.
     */
    @Test
    public void anAbsentOrUnusableRequestBodyMeansEveryScope() {
        assertEquals(List.of(), AgentResolver.parseRequestedScopes(null));
        assertEquals(List.of(), AgentResolver.parseRequestedScopes(""));
        assertEquals(List.of(), AgentResolver.parseRequestedScopes("   "));
        assertEquals(List.of(), AgentResolver.parseRequestedScopes("{}"));
        assertEquals(List.of(), AgentResolver.parseRequestedScopes("not json at all"));
        assertEquals(List.of(), AgentResolver.parseRequestedScopes("{\"scopes\":[]}"));
    }

    /** An explicit list is honoured, in the order the client wrote it. */
    @Test
    public void readsTheScopeListFromTheRequestBody() {
        assertEquals(List.of("local", "store"),
                AgentResolver.parseRequestedScopes("{\"scopes\":[\"local\",\"store\"]}"));
    }

    /**
     * A scope this build does not know is rejected rather than silently
     * dropped.
     *
     * <p>Answering a typo like {@code "future"} with the full list would leave
     * the caller unable to tell that its filter was ignored — it would look
     * exactly like a filter that matched everything. Partly-valid requests are
     * strict too: mixing a real scope with an unknown one is a bug worth
     * reporting, not a request to quietly return the one that parsed.
     */
    @Test
    public void unknownScopesAreRejectedRatherThanSilentlyWidened() {
        IllegalArgumentException unknown =
                assertThrows(IllegalArgumentException.class,
                        () -> AgentResolver.parseRequestedScopes("{\"scopes\":[\"future\"]}"));
        assertTrue("the message must name the offending scope, was: " + unknown.getMessage(),
                unknown.getMessage().contains("future"));

        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.parseRequestedScopes("{\"scopes\":[\"global\",\"future\"]}"));
        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.parseRequestedScopes("{\"scope\":\"projekt\"}"));
    }

    /**
     * A non-string element is rejected for the same reason an unknown name is:
     * dropping it would leave the request looking empty, and an empty request
     * means "every scope" — so the client would receive all 150 agents and have
     * no way to tell its filter was ignored.
     */
    @Test
    public void nonStringScopesAreRejectedRatherThanTreatedAsNoFilter() {
        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.parseRequestedScopes("{\"scopes\":[123,456]}"));
        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.parseRequestedScopes("{\"scopes\":[true]}"));
        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.parseRequestedScopes("{\"scopes\":[{\"a\":1}]}"));
        // The bare field is held to the same standard as the array form.
        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.parseRequestedScopes("{\"scope\":7}"));
    }

    /** A null element is an absence, not a type error, and is skipped. */
    @Test
    public void aNullElementIsSkippedRatherThanRejected() {
        assertEquals(List.of("global"),
                AgentResolver.parseRequestedScopes("{\"scopes\":[\"global\",null]}"));
    }

    /**
     * A fully valid request is unaffected by the strictness above, so the
     * rejection cannot regress into rejecting good input.
     */
    @Test
    public void everyKnownScopeIsStillAccepted() {
        assertEquals(List.of("store", "global", "local"),
                AgentResolver.parseRequestedScopes("{\"scopes\":[\"store\",\"global\",\"local\"]}"));
    }

    /** A single-scope request returns only that scope's agents. */
    @Test
    public void resolveReturnsOnlyTheRequestedScopes() throws IOException {
        Path globalRoot = agentsRoot("g");
        Path localRoot = agentsRoot("l");
        write(globalRoot.resolve("g-one.md"), AGENT_FILE.replace("{name}", "g-one"));
        write(localRoot.resolve("l-one.md"), AGENT_FILE.replace("{name}", "l-one"));
        List<JsonObject> store = List.of(storeAgent("s-one", "a prompt"));
        ScanResult scan = scan(globalRoot, AgentFields.SCOPE_GLOBAL,
                localRoot, AgentFields.SCOPE_LOCAL);

        assertEquals(List.of("s-one"),
                names(AgentResolver.resolve(store, scan, DenyIndex.empty(), List.of("store"))));
        assertEquals(List.of("g-one"),
                names(AgentResolver.resolve(store, scan, DenyIndex.empty(), List.of("global"))));
        assertEquals(List.of("g-one", "l-one"),
                names(AgentResolver.resolve(store, scan, DenyIndex.empty(),
                        List.of("global", "local"))));
    }

    /**
     * An unknown scope reaches {@code resolve} and is rejected there, not
     * dropped.
     *
     * <p>The parser already rejects one in a request body, so this is the
     * second door to the same room: {@code resolve} takes the scope list
     * directly and is public, so a caller need not go through the parser at
     * all. A silent filter would answer a caller that named two scopes with
     * the single one that parsed — a result indistinguishable from "your
     * filter matched nothing", which is the same silence the parser was fixed
     * to stop.
     */
    @Test
    public void resolveRejectsAnUnknownScopeRatherThanFilteringItOut() throws IOException {
        Path globalRoot = agentsRoot("g");
        write(globalRoot.resolve("g-one.md"), AGENT_FILE.replace("{name}", "g-one"));
        List<JsonObject> store = List.of(storeAgent("s-one", "a prompt"));
        ScanResult scan = scan(globalRoot, AgentFields.SCOPE_GLOBAL);

        // One valid scope, one this build does not know.
        IllegalArgumentException unknown = assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.resolve(store, scan, DenyIndex.empty(),
                        List.of(AgentFields.SCOPE_GLOBAL, "future")));
        assertTrue("the message must name the offending scope, was: " + unknown.getMessage(),
                unknown.getMessage().contains("future"));
        assertTrue("the message must name the supported scopes, was: " + unknown.getMessage(),
                unknown.getMessage().contains(AgentFields.SCOPE_GLOBAL));

        // The order does not matter, and neither does the count: a lone unknown
        // scope is rejected just the same.
        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.resolve(store, scan, DenyIndex.empty(),
                        List.of("future", AgentFields.SCOPE_GLOBAL)));
        assertThrows(IllegalArgumentException.class,
                () -> AgentResolver.resolve(store, scan, DenyIndex.empty(), List.of("future")));

        // A fully valid list is unaffected, so the check cannot regress into
        // rejecting good input.
        assertEquals(List.of("g-one", "s-one"),
                names(AgentResolver.resolve(store, scan, DenyIndex.empty(),
                        List.of(AgentFields.SCOPE_GLOBAL, AgentFields.SCOPE_STORE))));
    }

    /**
     * The scope filter runs <em>after</em> precedence, not before. Filtering
     * first would let a shadowed store entry reappear the moment the client
     * asked for "store" only — the same agent would be visible under two
     * different requests, with two different bodies.
     */
    @Test
    public void theScopeFilterDoesNotResurrectAShadowedEntry() throws IOException {
        Path globalRoot = agentsRoot("g");
        write(globalRoot.resolve("reviewer.md"), AGENT_FILE.replace("{name}", "reviewer"));

        Resolution storeOnly = AgentResolver.resolve(
                List.of(storeAgent("reviewer", "an imported copy")),
                scan(globalRoot, AgentFields.SCOPE_GLOBAL),
                DenyIndex.empty(), List.of("store"));

        assertTrue("the global file shadows the store entry, so no store agent remains",
                storeOnly.agents().isEmpty());
    }

    // ==================================================================
    // 3. Deny marking (R8, AC5)
    // ==================================================================

    /**
     * AC5: an agent named in {@code permissions.deny} is visibly disabled, in
     * every scope — a deny rule addresses a name, not a file, so where the
     * plugin found the definition does not change the answer.
     */
    @Test
    public void agentsNamedInDenyAreMarkedDisabled() throws IOException {
        Path globalRoot = agentsRoot("g");
        write(globalRoot.resolve("Explore.md"), AGENT_FILE.replace("{name}", "Explore"));
        DenyIndex deny = AgentDenyRules.read(
                writeSettings("{\"permissions\":{\"deny\":[\"Agent(Explore)\"]}}"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("Explore", "a prompt")),
                scan(globalRoot, AgentFields.SCOPE_GLOBAL),
                deny, AgentResolver.ALL_SCOPES);

        // One name, one agent: the file shadows the store copy, and both are denied.
        assertEquals(1, resolution.agents().size());
        JsonObject agent = resolution.agents().get(0);
        assertTrue(agent.get("disabled").getAsBoolean());
        assertNotNull(agent.get("disabledReason").getAsString());
        assertTrue(agent.get("disabledReason").getAsString().contains("Agent(Explore)"));
    }

    /** An agent nobody denied carries no {@code disabled} field at all. */
    @Test
    public void anAgentOutsideDenyIsNotMarked() throws IOException {
        DenyIndex deny = AgentDenyRules.read(
                writeSettings("{\"permissions\":{\"deny\":[\"Agent(Explore)\"]}}"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("code-reviewer", "a prompt")),
                ScanResult.empty(), deny, AgentResolver.ALL_SCOPES);

        JsonObject agent = resolution.agents().get(0);
        assertFalse(agent.has("disabled"));
        assertFalse(agent.has("disabledReason"));
    }

    /**
     * A deny rule that names no known agent is reported instead of vanishing.
     * The usual cause is a rule for an agent that comes from a plugin, or a
     * typo — either way the user is better served by being told than by
     * silently seeing a rule that does nothing.
     *
     * <p>The rule is reported exactly as it was written, so a future UI can
     * quote the user's own text rather than reconstructing it.
     */
    @Test
    public void aDenyRuleMatchingNoAgentIsReported() throws IOException {
        DenyIndex deny = AgentDenyRules.read(
                writeSettings("{\"permissions\":{\"deny\":"
                        + "[\"Agent(Explore)\",\"Agent(ghost)\"]}}"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("Explore", "a prompt")),
                ScanResult.empty(), deny, AgentResolver.ALL_SCOPES);

        assertEquals(List.of("Agent(ghost)"), resolution.unmatchedDenyRules());
    }

    /** {@code Agent(*)} marks every resolved agent, whichever scope it came from. */
    @Test
    public void denyAllMarksEveryAgent() throws IOException {
        DenyIndex deny = AgentDenyRules.read(writeSettings("{\"permissions\":{\"deny\":"
                + "[\"Agent(*)\"]}}"));

        Resolution resolution = AgentResolver.resolve(
                List.of(storeAgent("a", "p"), storeAgent("b", "p")),
                ScanResult.empty(), deny, AgentResolver.ALL_SCOPES);

        assertTrue(resolution.agents().stream()
                .allMatch(agent -> agent.get("disabled").getAsBoolean()));
    }

    // ==================================================================
    // 4. What a discovered agent looks like on the wire
    // ==================================================================

    /**
     * The specification fields the scanner parsed travel to the client as
     * top-level properties, beside the discovery metadata. The field names are
     * the specification's own, so the TypeScript model can declare them
     * directly instead of nesting a raw frontmatter blob.
     */
    @Test
    public void aDiscoveredAgentCarriesItsSpecificationFieldsAndPath() throws IOException {
        Path globalRoot = agentsRoot("g");
        write(globalRoot.resolve("code-reviewer.md"), String.join("\n",
                "---",
                "name: code-reviewer",
                "description: Reviews diffs",
                "model: sonnet",
                "permissionMode: plan",
                "maxTurns: 8",
                "background: true",
                "---",
                "You review code.",
                ""));

        Resolution resolution = AgentResolver.resolve(
                List.of(), scan(globalRoot, AgentFields.SCOPE_GLOBAL),
                DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        JsonObject agent = resolution.agents().get(0);
        assertEquals("Reviews diffs", agent.get("description").getAsString());
        assertEquals("sonnet", agent.get("model").getAsString());
        assertEquals("plan", agent.get("permissionMode").getAsString());
        assertEquals(8, agent.get("maxTurns").getAsInt());
        assertTrue(agent.get("background").getAsBoolean());
        assertEquals(AgentFields.SCOPE_GLOBAL, agent.get("scope").getAsString());
        assertEquals(AgentFields.SCOPE_GLOBAL, agent.get("source").getAsString());
        assertTrue(agent.get("readOnly").getAsBoolean());
        assertEquals(globalRoot.resolve("code-reviewer.md").toRealPath().toString(),
                agent.get("path").getAsString());
    }

    /**
     * A file whose frontmatter cannot be trusted is still listed, carrying the
     * parser's explanation. Dropping it would hide the very file the user
     * needs to fix (AC3).
     */
    @Test
    public void anUnloadableFileIsStillListedWithItsWarning() throws IOException {
        Path globalRoot = agentsRoot("g");
        write(globalRoot.resolve("broken.md"), "---\nname: broken\n  bad: [unclosed\n---\nbody\n");

        Resolution resolution = AgentResolver.resolve(
                List.of(), scan(globalRoot, AgentFields.SCOPE_GLOBAL),
                DenyIndex.empty(), AgentResolver.ALL_SCOPES);

        assertEquals(List.of("broken"), names(resolution));
        JsonObject agent = resolution.agents().get(0);
        assertNotNull(agent.get("warning").getAsString());
        assertTrue(agent.get("readOnly").getAsBoolean());
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    /** A store entry in the shape {@code AgentManager} hands over. */
    private static JsonObject storeAgent(String name, String prompt) {
        JsonObject agent = new JsonObject();
        agent.addProperty("id", "store-" + name);
        agent.addProperty("name", name);
        agent.addProperty("prompt", prompt);
        agent.addProperty("createdAt", 1L);
        agent.addProperty("scope", AgentFields.SCOPE_STORE);
        agent.addProperty("source", AgentFields.SCOPE_STORE);
        agent.addProperty("readOnly", false);
        return agent;
    }

    private static ScanResult scan(Path globalRoot, String globalScope) {
        return SubagentDiscoveryScanner.scanDirectory(globalRoot, globalScope);
    }

    private static ScanResult scan(Path globalRoot, String globalScope, Path localRoot,
                                   String localScope) {
        ScanResult first = SubagentDiscoveryScanner.scanDirectory(globalRoot, globalScope);
        ScanResult second = SubagentDiscoveryScanner.scanDirectory(localRoot, localScope);
        return new ScanResult(
                concat(first.entries(), second.entries()),
                concat(first.warnings(), second.warnings()));
    }

    private static <T> List<T> concat(List<T> first, List<T> second) {
        return java.util.stream.Stream.concat(first.stream(), second.stream()).toList();
    }

    private Path agentsRoot(String folder) throws IOException {
        return Files.createDirectories(temp.newFolder(folder).toPath()
                .resolve(".claude").resolve("agents"));
    }

    private static void write(Path file, String content) throws IOException {
        Files.writeString(file, content, StandardCharsets.UTF_8);
    }

    private Path writeSettings(String content) throws IOException {
        Path file = Files.createDirectories(
                temp.newFolder("home-" + System.nanoTime()).toPath().resolve(".claude"))
                .resolve("settings.json");
        return writeFile(file, content);
    }

    private static Path writeFile(Path file, String content) throws IOException {
        Files.writeString(file, content, StandardCharsets.UTF_8);
        return file;
    }

    private static List<String> names(Resolution resolution) {
        return resolution.agents().stream()
                .map(agent -> agent.get("name").getAsString())
                .sorted()
                .toList();
    }

    private static Set<String> scopes(Resolution resolution) {
        return resolution.agents().stream()
                .map(agent -> agent.get("scope").getAsString())
                .collect(Collectors.toSet());
    }
}
