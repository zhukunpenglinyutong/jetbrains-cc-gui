package com.github.claudecodegui.agent;

import com.github.claudecodegui.agent.AgentDenyRules.DenyIndex;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Behaviour tests for {@link AgentDenyRules} (task 59, PRD R8 / AC5).
 *
 * <p>The rule format was confirmed against the Claude Code documentation
 * (code.claude.com/docs/en/sub-agents, "Disable specific subagents" and
 * code.claude.com/docs/en/permissions):
 *
 * <pre>
 * { "permissions": { "deny": ["Agent(Explore)", "Agent(my-custom-agent)"] } }
 * </pre>
 *
 * <p>Two groups of evidence are pinned here.
 *
 * <ol>
 *   <li><b>What matches what.</b> The inner value of {@code Agent(...)} is the
 *       subagent's {@code name} field, compared exactly. A rule that carries a
 *       colon is a <em>parameter</em> matcher ({@code Agent(model:opus)},
 *       {@code Agent(isolation:*)}) and is deliberately not treated as a name.</li>
 *   <li><b>Failure containment.</b> A missing file, a missing
 *       {@code permissions} block, a missing {@code deny} array, a broken JSON
 *       document and a {@code deny} array holding non-strings all degrade to an
 *       empty deny list without throwing. A settings file the plugin cannot
 *       parse must never take the Agents tab down with it.</li>
 * </ol>
 *
 * <p>Every path here lives in a {@link TemporaryFolder}. The developer's real
 * {@code ~/.claude/settings.json} is never opened.
 */
public class AgentDenyRulesTest {

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    // ==================================================================
    // 1. Reading real rules
    // ==================================================================

    /**
     * The documented shape, verbatim: two agents in the deny array, one not.
     */
    @Test
    public void readsAgentNamesFromTheDenyArray() throws IOException {
        DenyIndex index = read("{\n"
                + "  \"permissions\": {\n"
                + "    \"deny\": [\"Agent(Explore)\", \"Agent(my-custom-agent)\", \"Bash(rm:*)\"]\n"
                + "  }\n"
                + "}");

        assertTrue(index.denies("Explore"));
        assertTrue(index.denies("my-custom-agent"));
        assertFalse("a rule that names another agent must not deny this one",
                index.denies("code-reviewer"));
        // Non-Agent rules are not this reader's business at all.
        assertEquals(List.of(), index.parameterRules());
        assertTrue("a readable file has nothing to report", index.problems().isEmpty());
    }

    /**
     * A deny list mixed with other tools' rules still yields the agent names:
     * the array is shared with every permission rule Claude Code understands.
     */
    @Test
    public void toleratesNonStringEntriesAndOtherToolsRules() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"deny\":"
                + "[\"Read\", \"Agent(Explore)\", 42, null, {\"nested\":true}, [1,2]"
                + "]}}");

        assertEquals(1, index.deniedNames().size());
        assertTrue(index.denies("Explore"));
    }

    /**
     * Surrounding whitespace is a formatting habit, not semantics. The value
     * inside the parentheses is trimmed, the rule itself is not loosened.
     */
    @Test
    public void trimsWhitespaceAroundTheRuleAndTheName() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"deny\":[\"  Agent( spaced )  \"]}}");

        assertTrue(index.denies("spaced"));
        assertFalse(index.denies(" spaced "));
    }

    // ==================================================================
    // 2. Rules that look like agent names but are not
    // ==================================================================

    /**
     * Since the week-25 release Claude Code also matches deny rules against a
     * spawn's input parameters: {@code Agent(model:opus)} denies every spawn
     * requesting Opus, {@code Agent(isolation:*)} any explicit isolation. The
     * colon is the discriminator — and a colon is exactly what the
     * specification forbids inside an agent name, so the two forms can never be
     * confused.
     *
     * <p>Such a rule is recognized and reported, never mistaken for a name.
     * Treating {@code Agent(model:opus)} as a name would disable an agent
     * literally called "model:opus", which cannot exist.
     */
    @Test
    public void doesNotTreatParameterMatchingRulesAsNames() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"deny\":"
                + "[\"Agent(model:opus)\", \"Agent(isolation:*)\", \"Agent(Explore)\"]}}");

        assertEquals(List.of("Agent(model:opus)", "Agent(isolation:*)"), index.parameterRules());
        assertEquals(1, index.deniedNames().size());
        assertFalse(index.denies("model:opus"));
        assertTrue(index.denies("Explore"));
    }

    /**
     * Names are compared exactly, and that is a deliberate choice rather than
     * an oversight. A case-insensitive fallback would be friendlier for the
     * plugin store, whose legacy names contain spaces and capitals ("New
     * Agent"), but it can only ever produce a <em>false</em> "disabled" badge —
     * telling the user Claude refuses to run an agent it will happily run. A
     * missed badge costs nothing; a wrong one costs trust. The exact rule also
     * matches what Claude Code itself does with the name field.
     */
    @Test
    public void comparesNamesExactlyAndCaseSensitively() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"deny\":[\"Agent(Code-Reviewer)\"]}}");

        assertTrue(index.denies("Code-Reviewer"));
        assertFalse("case must not be folded", index.denies("code-reviewer"));
    }

    /**
     * A rule that is not a well-formed {@code Agent(...)} rule is ignored: the
     * prefix and the closing parenthesis are both required, so a bare word or a
     * half-written rule cannot deny an agent by accident.
     */
    @Test
    public void ignoresRulesThatAreNotWellFormedAgentRules() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"deny\":"
                + "[\"Agent Explore\", \"Agent(\", \"Agent(Explore\", \"agent(Explore)\","
                + " \"Agent()\"]}}");

        assertEquals(List.of(), List.copyOf(index.deniedNames()));
        assertFalse(index.denies("Explore"));
    }

    /**
     * {@code Agent(*)} denies every spawn. The wildcard is the same token the
     * parameter form uses, but on its own it has nothing to parameterise, so it
     * is read as "every agent" — the only reading that agrees with what the
     * user wrote.
     */
    @Test
    public void treatsBareWildcardAsDenyAll() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"deny\":[\"Agent(*)\"]}}");

        assertTrue(index.denyAll());
        assertTrue(index.denies("anything-at-all"));
        assertTrue("a name rule beside it is still read", read(
                "{\"permissions\":{\"deny\":[\"Agent(*)\",\"Agent(Explore)\"]}}")
                .denies("Explore"));
    }

    // ==================================================================
    // 3. Degenerate settings files
    // ==================================================================

    /**
     * A file that exists but cannot be parsed is reported and treated as "no
     * rules", never as an error. The Agents tab must still render every agent
     * when the user's settings.json is mid-edit.
     */
    @Test
    public void brokenSettingsFileYieldsNoRulesAndAPlainProblem() throws IOException {
        DenyIndex index = read("{ \"permissions\": { \"deny\": [\"Agent(Explore)\", ");

        assertTrue(index.deniedNames().isEmpty());
        assertFalse(index.denies("Explore"));
        assertEquals(1, index.problems().size());
    }

    /** No {@code permissions} node at all is an ordinary file, not a problem. */
    @Test
    public void missingPermissionsBlockYieldsNoRules() throws IOException {
        DenyIndex index = read("{\"env\":{\"ANTHROPIC_API_KEY\":\"x\"}}");

        assertTrue(index.deniedNames().isEmpty());
        assertTrue(index.problems().isEmpty());
    }

    /** A {@code permissions} block without {@code deny} is likewise ordinary. */
    @Test
    public void missingDenyArrayYieldsNoRules() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"allow\":[\"Bash(git:*)\"],"
                + "\"defaultMode\":\"acceptEdits\"}}");

        assertTrue(index.deniedNames().isEmpty());
        assertTrue(index.problems().isEmpty());
    }

    /** {@code deny} of the wrong type is reported rather than silently dropped. */
    @Test
    public void denyOfTheWrongTypeYieldsNoRulesAndAPlainProblem() throws IOException {
        DenyIndex index = read("{\"permissions\":{\"deny\":\"Agent(Explore)\"}}");

        assertTrue(index.deniedNames().isEmpty());
        assertEquals(1, index.problems().size());
    }

    /**
     * The common case for a user who never wrote a deny rule: no file. Nothing
     * is reported, because nothing is wrong.
     */
    @Test
    public void missingSettingsFileYieldsNoRules() throws IOException {
        DenyIndex index = AgentDenyRules.read(settingsFile().getParent().resolve("absent.json"));

        assertTrue(index.deniedNames().isEmpty());
        assertFalse(index.denies("Explore"));
        assertTrue(index.problems().isEmpty());
    }

    /** A directory where a file is expected is a read failure, not a crash. */
    @Test
    public void unreadableSettingsPathYieldsNoRules() throws IOException {
        DenyIndex index = AgentDenyRules.read(temp.newFolder("a-directory").toPath());

        assertTrue(index.deniedNames().isEmpty());
        assertTrue(index.problems().isEmpty());
    }

    /** A null path means "do not read anything" and must stay quiet. */
    @Test
    public void nullPathYieldsNoRules() {
        DenyIndex index = AgentDenyRules.read(null);

        assertTrue(index.deniedNames().isEmpty());
        assertFalse(index.denies("Explore"));
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    /** Write {@code content} to a fresh {@code ~/.claude/settings.json} and read it. */
    private DenyIndex read(String content) throws IOException {
        Path file = settingsFile();
        Files.writeString(file, content, StandardCharsets.UTF_8);
        return AgentDenyRules.read(file);
    }

    /** A per-test settings file, so no two tests share one. */
    private Path settingsFile() throws IOException {
        Path dir = Files.createDirectories(
                temp.newFolder("home-" + System.nanoTime()).toPath().resolve(".claude"));
        return dir.resolve("settings.json");
    }
}
