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
 * <h2>Settings hierarchy</h2>
 *
 * <p>Deny rules are read from the full hierarchy, highest precedence first:
 * <ol>
 *   <li>Managed settings (enterprise/org policy): Linux {@code /etc/claude-code/managed-settings.json},
 *       macOS {@code /Library/Application Support/ClaudeCode/managed-settings.json},
 *       Windows {@code %ProgramFiles%\ClaudeCode\managed-settings.json}</li>
 *   <li>User-level: {@code ~/.claude/settings.json}</li>
 *   <li>Project-level: {@code {workspace}/.claude/settings.json}</li>
 *   <li>Project local: {@code {workspace}/.claude/settings.local.json}</li>
 * </ol>
 * Rules are unioned — a name denied at any level is denied.
 * The managed settings file is only read on the corresponding OS; the legacy
 * {@code %PROGRAMDATA%\Claude\settings.json} is not read per the documentation.
 *
 * <h2>Rule forms</h2>
 *
 * <ul>
 *   <li>{@code Agent(name)} — denies the subagent with this exact name</li>
 *   <li>{@code Agent(*)} — denies every subagent (wildcard)</li>
 *   <li>{@code Task(name)} — alias form, still works as an alias per documentation</li>
 *   <li>{@code Agent(param:value)} — parameter rules (e.g., {@code model:opus}), kept for display only</li>
 * </ul>
 *
 * <h2>Bare Agent tool deny</h2>
 *
 * <p>A bare {@code "Agent"} entry in the deny array (no parentheses) disables
 * every subagent. This is equivalent to {@code Agent(*)}.
 */
public final class AgentDenyRules {

    private static final Logger LOG = Logger.getInstance(AgentDenyRules.class);

    private static final String CLAUDE_DIR = ".claude";
    private static final String SETTINGS_FILE = "settings.json";
    private static final String LOCAL_SETTINGS_FILE = "settings.local.json";
    private static final String MANAGED_SETTINGS_FILE = "managed-settings.json";

    /** The prefix every agent rule starts with. */
    private static final String RULE_PREFIX = "Agent(";
    /** Alias form prefix. */
    private static final String TASK_PREFIX = "Task(";

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
            return deniedNames.contains(agentName) ? RULE_PREFIX + agentName + ")" : null;
        }
    }

    // ------------------------------------------------------------------
    // Reading
    // ------------------------------------------------------------------

    /**
     * Read the deny rules for a project, combining the full hierarchy.
     *
     * <p>Order of precedence (highest first, but rules are unioned):
     * <ol>
     *   <li>Managed settings (OS-specific)</li>
     *   <li>User-level: {@code ~/.claude/settings.json}</li>
     *   <li>Project-level: {@code {workspace}/.claude/settings.json}</li>
     *   <li>Project local: {@code {workspace}/.claude/settings.local.json}</li>
     * </ol>
     *
     * @param workspaceRoot the effective working directory, or null/blank for no project
     * @return the combined rules from all levels
     */
    public static DenyIndex readForProject(String workspaceRoot) {
        Set<String> allNames = new LinkedHashSet<>();
        List<String> allParameterRules = new ArrayList<>();
        boolean anyDenyAll = false;
        List<String> allProblems = new ArrayList<>();

        // 1. Managed settings (OS-specific)
        List<Path> managedPaths = managedSettingsPaths();
        for (Path p : managedPaths) {
            DenyIndex idx = read(p);
            mergeInto(idx, allNames, allParameterRules, anyDenyAll, allProblems);
            anyDenyAll = anyDenyAll || idx.denyAll();
        }

        // 2. User-level settings
        Path userSettings = currentSettingsPath();
        DenyIndex userIdx = read(userSettings);
        mergeInto(userIdx, allNames, allParameterRules, anyDenyAll, allProblems);
        anyDenyAll = anyDenyAll || userIdx.denyAll();

        // 3. Project-level settings
        if (workspaceRoot != null && !workspaceRoot.isBlank()) {
            Path projectSettings = Paths.get(workspaceRoot, CLAUDE_DIR, SETTINGS_FILE);
            DenyIndex projectIdx = read(projectSettings);
            mergeInto(projectIdx, allNames, allParameterRules, anyDenyAll, allProblems);
            anyDenyAll = anyDenyAll || projectIdx.denyAll();

            // 4. Project local settings
            Path localSettings = Paths.get(workspaceRoot, CLAUDE_DIR, LOCAL_SETTINGS_FILE);
            DenyIndex localIdx = read(localSettings);
            mergeInto(localIdx, allNames, allParameterRules, anyDenyAll, allProblems);
            anyDenyAll = anyDenyAll || localIdx.denyAll();
        }

        DenyIndex combined = new DenyIndex(
                Collections.unmodifiableSet(allNames),
                anyDenyAll,
                List.copyOf(allParameterRules),
                List.copyOf(allProblems)
        );

        LOG.info("[AgentDeny] Combined deny rules: " + allNames.size() + " denied agent name(s), "
                + (anyDenyAll ? "plus a deny-all rule, " : "")
                + allParameterRules.size() + " parameter rule(s), "
                + allProblems.size() + " problem(s)");
        return combined;
    }

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
                // Check for bare "Agent" (no parentheses) - denies all
                if (rule.equalsIgnoreCase("Agent")) {
                    denyAll = true;
                }
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

        DenyIndex index = new DenyIndex(Collections.unmodifiableSet(names), denyAll,
                List.copyOf(parameterRules), List.of());
        LOG.info("[AgentDeny] Read " + names.size() + " denied agent name(s), "
                + (denyAll ? "plus a deny-all rule, " : "")
                + parameterRules.size() + " parameter rule(s)");
        return index;
    }

    /**
     * Merge one DenyIndex into the accumulating sets.
     */
    private static void mergeInto(DenyIndex src,
                                  Set<String> allNames,
                                  List<String> allParameterRules,
                                  boolean anyDenyAll,
                                  List<String> allProblems) {
        if (src == null) return;
        allNames.addAll(src.deniedNames());
        allParameterRules.addAll(src.parameterRules());
        allProblems.addAll(src.problems());
    }

    /**
     * The trimmed content between {@code Agent(} / {@code Task(} and the closing parenthesis.
     *
     * <p>Null for anything that is not a well-formed rule: the prefix and the
     * closing parenthesis are both required, so a bare word, a half-written
     * rule, or a rule for another tool cannot deny an agent by accident. An
     * empty value is rejected too — {@code Agent()} names nothing.
     */
    private static String innerValue(String rule) {
        // Check Agent(...) form
        if (rule.startsWith(RULE_PREFIX) && rule.endsWith(")")
                && rule.length() > RULE_PREFIX.length() + 1) {
            return rule.substring(RULE_PREFIX.length(), rule.length() - 1).trim();
        }
        // Check Task(...) alias form
        if (rule.startsWith(TASK_PREFIX) && rule.endsWith(")")
                && rule.length() > TASK_PREFIX.length() + 1) {
            return rule.substring(TASK_PREFIX.length(), rule.length() - 1).trim();
        }
        return null;
    }

    /** Copy an index with one extra problem note, leaving everything else alone. */
    private static DenyIndex withProblem(DenyIndex index, String problem) {
        List<String> problems = new ArrayList<>(index.problems());
        problems.add(problem);
        return new DenyIndex(index.deniedNames(), index.denyAll(),
                index.parameterRules(), List.copyOf(problems));
    }

    /**
     * The managed settings paths per OS (documented at
     * https://code.claude.com/docs/en/managed-settings).
     *
     * @return list of paths to check (one per OS, only the current OS's path exists)
     */
    private static List<Path> managedSettingsPaths() {
        List<Path> paths = new ArrayList<>();
        String os = System.getProperty("os.name").toLowerCase();
        if (os.contains("linux")) {
            paths.add(Paths.get("/etc", "claude-code", MANAGED_SETTINGS_FILE));
        } else if (os.contains("mac")) {
            paths.add(Paths.get("/Library", "Application Support", "ClaudeCode", MANAGED_SETTINGS_FILE));
        } else if (os.contains("windows")) {
            String programFiles = System.getenv("ProgramFiles");
            if (programFiles != null && !programFiles.isBlank()) {
                paths.add(Paths.get(programFiles, "ClaudeCode", MANAGED_SETTINGS_FILE));
            }
            // Note: legacy %PROGRAMDATA%\Claude\settings.json is NOT read per docs
        }
        return paths;
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