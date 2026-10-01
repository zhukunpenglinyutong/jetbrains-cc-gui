package com.github.claudecodegui.agent;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The {@code permissions.deny} rules that disable subagents (PRD task 59, R8).
 *
 * <p>Claude Code refuses to spawn a subagent whose name is listed in the deny
 * array of a settings file. The documentation
 * (code.claude.com/docs/en/sub-agents, "Disable specific subagents", and
 * code.claude.com/docs/en/permissions) gives the format as:
 *
 * <pre>
 * { "permissions": { "deny": ["Agent(Explore)", "Agent(my-custom-agent)"] } }
 * </pre>
 *
 * <p>where the value inside the parentheses is the subagent's {@code name}
 * frontmatter field.
 *
 * <h2>What is a name rule and what is not</h2>
 *
 * <p>The same {@code Agent(...)} shape also matches a spawn's input parameters,
 * documented as {@code Tool(param:value)} and released in week 25:
 * {@code Agent(model:opus)} denies every spawn requesting the Opus tier and
 * {@code Agent(isolation:*)} any spawn that sets isolation explicitly. A colon
 * is therefore the discriminator — and a colon is exactly the one character the
 * subagent specification forbids inside a name, so the two forms can never be
 * confused. Rules containing a colon are collected and reported, never read as
 * names: treating {@code Agent(model:opus)} as a name would disable an agent
 * literally called "model:opus", which cannot exist.
 *
 * <h2>Comparison</h2>
 *
 * <p>Names are compared <b>exactly</b>, case included. A case-insensitive
 * fallback would be friendlier towards the plugin store, whose legacy names do
 * contain spaces and capitals ("New Agent"), but it can only ever produce a
 * <em>false</em> "disabled" badge — telling the user that Claude refuses to run
 * an agent it will happily run. A missed badge costs nothing; a wrong one costs
 * trust, so the exact rule wins, and it is also what Claude Code itself does
 * with the name field.
 *
 * <h2>Read-only, and only one layer</h2>
 *
 * <p>This class opens {@code ~/.claude/settings.json} and never writes to it
 * (PRD NG4: editing settings.json is out of scope). Only the user-level file is
 * consulted: project {@code .claude/settings.json},
 * {@code .claude/settings.local.json} and the platform managed-settings file
 * exist too, and an agent denied by any of them would ideally be marked too.
 * Reading them is a one-line change once the plugin is prepared to say which
 * file a rule came from, and until then under-reporting is the safe direction.
 *
 * <p>Nothing here throws. A missing file, a half-edited document, a
 * {@code permissions} node of the wrong shape — all of them are ordinary states
 * that produce an empty rule set, because the Agents tab must keep rendering
 * every agent while a user's settings.json is being rewritten.
 */
public final class AgentDenyRules {

    private static final Logger LOG = Logger.getInstance(AgentDenyRules.class);

    private static final String CLAUDE_DIR = ".claude";
    private static final String SETTINGS_FILE = "settings.json";

    /** The prefix every agent rule starts with. */
    private static final String RULE_PREFIX = "Agent(";

    /** The token the specification forbids inside a name, and the parameter separator. */
    private static final char PARAMETER_SEPARATOR = ':';

    /** The wildcard on its own, with no parameter to bind: "every agent". */
    private static final String WILDCARD = "*";

    private AgentDenyRules() {
    }

    /**
     * The deny rules that apply to this session.
     *
     * <p>Immutable and safe to share; {@link #empty()} is the answer for every
     * state in which nothing could be read.
     *
     * @param deniedNames    the agent names the user refuses, exactly as written
     * @param denyAll        true when the rules deny every agent at once
     * @param parameterRules the {@code Agent(param:…)} rules, kept for display
     * @param problems       plain-language notes about a file that exists but
     *                       could not be used; empty for a file that is simply
     *                       absent or perfectly ordinary
     */
    public record DenyIndex(
            Set<String> deniedNames,
            boolean denyAll,
            List<String> parameterRules,
            List<String> problems
    ) {

        /** The answer for "no rules could be read", shared because it is immutable. */
        private static final DenyIndex EMPTY =
                new DenyIndex(Set.of(), false, List.of(), List.of());

        /**
         * The empty rule set.
         *
         * @return an index that denies nothing and reports nothing
         */
        public static DenyIndex empty() {
            return EMPTY;
        }

        /**
         * Whether a subagent of this name would be refused by Claude Code.
         *
         * @param agentName the agent's {@code name} field, or null
         * @return true when a name rule matches exactly, or every agent is denied
         */
        public boolean denies(String agentName) {
            return denyRuleFor(agentName) != null;
        }

        /**
         * The rule that refuses this agent, for the UI to quote.
         *
         * @param agentName the agent's {@code name} field, or null
         * @return the matching rule as the user wrote it, or null when the
         *         agent is not denied
         */
        public String denyRuleFor(String agentName) {
            if (denyAll) {
                return RULE_PREFIX + WILDCARD + ")";
            }
            if (agentName == null) {
                return null;
            }
            // The queried name is compared verbatim: the frontmatter parser and
            // AgentManager both hand over an already-trimmed name, and folding
            // whitespace here would quietly make the comparison looser than the
            // exact rule this class documents.
            return deniedNames.contains(agentName) ? RULE_PREFIX + agentName + ")" : null;
        }
    }

    // ------------------------------------------------------------------
    // Reading
    // ------------------------------------------------------------------

    /**
     * Read the user-level {@code ~/.claude/settings.json} of the current session.
     *
     * <p>The home comes from the WSL-aware resolver, for the same reason
     * {@link SubagentDiscoveryScanner} does it that way: on a Windows host
     * driving a WSL Node the home is a UNC path whose backslashes must survive
     * or every path silently resolves to nothing.
     *
     * @return the rules, or an empty set — never null, never throwing
     */
    public static DenyIndex readForCurrentHome() {
        return read(currentSettingsPath());
    }

    /**
     * Read the deny rules from an explicit settings file.
     *
     * <p>Separate from {@link #readForCurrentHome()} so the parsing can be
     * tested against a temporary file instead of the developer's own.
     *
     * @param settingsFile {@code settings.json}, which need not exist
     * @return the rules, or an empty set — never null, never throwing
     */
    public static DenyIndex read(Path settingsFile) {
        if (settingsFile == null) {
            return DenyIndex.empty();
        }
        if (!Files.isRegularFile(settingsFile)) {
            // Absent is the normal case for a user who never wrote a rule. A
            // directory or an unreadable path is quietly the same: no rules.
            return DenyIndex.empty();
        }

        String content;
        try {
            content = Files.readString(settingsFile, StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOG.warn("[AgentDeny] Cannot read settings file: " + e.getClass().getSimpleName());
            return withProblem(DenyIndex.empty(), "settings.json could not be read");
        }

        JsonObject settings;
        try {
            JsonElement parsed = JsonParser.parseString(content);
            if (!parsed.isJsonObject()) {
                return withProblem(DenyIndex.empty(), "settings.json is not a JSON object");
            }
            settings = parsed.getAsJsonObject();
        } catch (Exception e) {
            // Never log the document itself: a settings file can hold an API key.
            LOG.warn("[AgentDeny] settings.json is not parseable JSON, treating as no rules");
            return withProblem(DenyIndex.empty(), "settings.json is not parseable JSON");
        }

        return readDenyArray(settings);
    }

    /**
     * Pull the {@code permissions.deny} array out of a parsed settings document.
     *
     * <p>Every step tolerates a missing or mistyped node. A {@code permissions}
     * block without {@code deny} is an ordinary file, not a problem worth
     * showing; a {@code deny} of the wrong type is worth a note, because the
     * user believes they have rules in effect and the plugin would otherwise
     * say nothing at all.
     */
    private static DenyIndex readDenyArray(JsonObject settings) {
        JsonElement permissions = settings.get("permissions");
        if (permissions == null || !permissions.isJsonObject()) {
            return DenyIndex.empty();
        }
        JsonElement deny = permissions.getAsJsonObject().get("deny");
        if (deny == null) {
            return DenyIndex.empty();
        }
        if (!deny.isJsonArray()) {
            return withProblem(DenyIndex.empty(), "permissions.deny is not an array");
        }
        return readRules(deny.getAsJsonArray());
    }

    /**
     * Classify the rules in a deny array.
     *
     * <p>Only string entries are considered. Claude Code's own settings may
     * carry entries for tools this reader knows nothing about, and a deny
     * array shared with hand-edited JSON may hold anything; skipping what is not
     * a string keeps one odd entry from discarding the whole file.
     */
    private static DenyIndex readRules(JsonArray deny) {
        Set<String> names = new LinkedHashSet<>();
        List<String> parameterRules = new ArrayList<>();
        boolean denyAll = false;

        for (JsonElement element : deny) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                continue;
            }
            String rule = element.getAsString().trim();
            String value = innerValue(rule);
            if (value == null) {
                continue;
            }
            if (value.indexOf(PARAMETER_SEPARATOR) >= 0) {
                parameterRules.add(rule);
            } else if (WILDCARD.equals(value)) {
                denyAll = true;
            } else {
                names.add(value);
            }
        }

        // An unmodifiable view rather than Set.copyOf, whose iteration order is
        // unspecified: the order the user wrote the rules in is the order they
        // are reported in.
        DenyIndex index = new DenyIndex(Collections.unmodifiableSet(names), denyAll,
                List.copyOf(parameterRules), List.of());
        LOG.info("[AgentDeny] Read " + names.size() + " denied agent name(s), "
                + (denyAll ? "plus a deny-all rule, " : "")
                + parameterRules.size() + " parameter rule(s)");
        return index;
    }

    /**
     * The trimmed content between {@code Agent(} and the closing parenthesis.
     *
     * <p>Null for anything that is not a well-formed rule: the prefix and the
     * closing parenthesis are both required, so a bare word, a half-written
     * rule, or a rule for another tool cannot deny an agent by accident. An
     * empty value is rejected too — {@code Agent()} names nothing.
     */
    private static String innerValue(String rule) {
        if (!rule.startsWith(RULE_PREFIX) || !rule.endsWith(")")
                || rule.length() <= RULE_PREFIX.length() + 1) {
            return null;
        }
        return rule.substring(RULE_PREFIX.length(), rule.length() - 1).trim();
    }

    /** Copy an index with one extra problem note, leaving everything else alone. */
    private static DenyIndex withProblem(DenyIndex index, String problem) {
        List<String> problems = new ArrayList<>(index.problems());
        problems.add(problem);
        return new DenyIndex(index.deniedNames(), index.denyAll(),
                index.parameterRules(), List.copyOf(problems));
    }

    /**
     * The user-level settings file of the current session.
     *
     * @return the path, which need not exist
     */
    public static Path currentSettingsPath() {
        return Paths.get(NodeDetector.resolveHomeForFileOps(), CLAUDE_DIR, SETTINGS_FILE);
    }
}
