package com.github.claudecodegui.agent;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.AgentFields;
import com.github.claudecodegui.util.LogSanitizer;
import com.github.claudecodegui.model.SubagentFrontmatterParser;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Read-only discovery of Claude Code subagent files (PRD task 58, R1/R2/R14).
 *
 * <p>Mirrors {@code SkillService}'s approach deliberately, because it is the
 * one precedent in this codebase for "look in the two Claude directories and
 * report what is there": two fixed roots, one scope each, no cache, and a
 * missing directory is an ordinary empty answer rather than an error. What is
 * <em>not</em> copied is the part where skills can write — this class opens
 * files for reading and does nothing else (AC6).
 *
 * <h2>Roots</h2>
 *
 * <ul>
 *   <li>{@code ~/.claude/agents} — scope {@link AgentFields#SCOPE_GLOBAL}. The
 *       home comes from {@link NodeDetector#resolveHomeForFileOps()}, not from
 *       {@code System.getProperty("user.home")}, for two reasons: IntelliJ may
 *       override that property, and on a Windows host driving a WSL Node the
 *       home is a UNC path that has to keep its backslashes or every
 *       {@code ~/.claude} scan silently comes back empty.</li>
 *   <li>{@code {workspace}/.claude/agents} — scope {@link AgentFields#SCOPE_LOCAL}.
 *       The workspace is passed in rather than derived here, so the caller stays
 *       the single place that decides what "the project" is: the handlers pass
 *       {@code context.resolveEffectiveWorkingDirectory()}, which already
 *       accounts for a user-configured custom working directory.</li>
 * </ul>
 *
 * <h2>Scan semantics</h2>
 *
 * <p>Top-level {@code *.md} only, no recursion — a subdirectory is invisible to
 * Claude Code too, and listing it would promise an agent the runtime will not
 * load. Bodies are never read: every file goes through
 * {@link SubagentFrontmatterParser#parse(Path)}, which streams and stops at the
 * closing delimiter, so a 200 KB system prompt costs the same as a 60-byte
 * frontmatter. There is deliberately no cache, matching the skills scan; the
 * sweep is a directory listing plus a bounded read per file, and the
 * alternative is a staleness bug across two roots and a settings dialog.
 *
 * <p>What happens to a file that is not a usable agent:
 *
 * <ul>
 *   <li><b>No frontmatter</b> — skipped, quietly. 122 of the 274 real files in
 *       the developer's agents directory are reference notes, and a note is not
 *       a problem worth a warning.</li>
 *   <li><b>Frontmatter present but unusable</b> — kept as a non-loadable entry
 *       <em>and</em> recorded in the warnings. PRD AC3 asks the UI to say why an
 *       agent did not load, which is impossible if the entry is dropped here.</li>
 *   <li><b>Not {@code *.md}, hidden, or a reserved documentation name</b> —
 *       skipped silently; they are layout, not errors.</li>
 * </ul>
 *
 * <h2>Symlink containment (R14)</h2>
 *
 * <p>Every candidate is resolved with {@link Path#toRealPath()} and the result
 * must start with the <em>resolved</em> root. Resolving both sides is what makes
 * the check work: a root reached through a symlink (macOS {@code /tmp} is one)
 * still matches its own children, while a link that points out of the tree
 * resolves to a path that does not begin with the root and is refused before a
 * single byte is read. The entry directory listing cannot otherwise be
 * confused, because a path handed to us by a directory listing can only leave
 * that directory through a link.
 *
 * <p>Two details fall out of doing it this way. The <em>real</em> path, not the
 * link, is what gets parsed and reported — so a link pointing at a file already
 * inside the root collapses onto that file instead of producing a second agent
 * for the same bytes, and the path handed to the UI is always a file the scan
 * actually read. And a link that <em>does</em> stay inside the root is allowed:
 * it is an alias for a file the user already chose to expose, not an escape.
 *
 * <p>The root itself gets the same treatment one level up. If
 * {@code ~/.claude/agents} is itself a link pointing at {@code ~/.ssh}, then
 * the resolved root is that directory and every containment check below it
 * passes — correctly, since those files really are inside the root. The scan
 * still completes and the agents are still listed; what changes is that a
 * warning is recorded, because the user asked to see what is in
 * {@code ~/.claude/agents} and is owed to know it is not there. The
 * comparison is against the <em>resolved</em> Claude directory, so a user who
 * symlinks {@code ~/.claude} itself is not warned about their own layout.
 *
 * <p>The check is inherently check-then-open, and a determined local attacker
 * could still swap the target between the two. Closing that would mean opening
 * a file descriptor against the resolved path and reading through it, which the
 * parser's {@code Path} entry point does not offer; a symlink pointing at a
 * readable file the user owns is not the threat model here.
 *
 * <h2>What is never logged</h2>
 *
 * <p>Log lines carry a scope, a file name, a count and a reason code. They
 * never carry a parsed warning or any field value: a broken frontmatter block
 * makes snakeyaml quote the offending source line, and agent files hold system
 * prompts. The parser's explanation is passed to the caller for the UI and
 * stopped there (R14).
 */
public final class SubagentDiscoveryScanner {

    private static final Logger LOG = Logger.getInstance(SubagentDiscoveryScanner.class);

    /** The Claude directory, and the agents directory inside it. */
    private static final String CLAUDE_DIR = ".claude";
    private static final String AGENTS_DIR = "agents";

    /** The only extension Claude Code treats as an agent file. */
    private static final String MARKDOWN_EXTENSION = ".md";

    private SubagentDiscoveryScanner() {
    }

    // ------------------------------------------------------------------
    // Result types
    // ------------------------------------------------------------------

    /**
     * Why a file did not make it into the sweep as a normal agent.
     *
     * <p>These are the reasons a <em>person</em> might want to know. A file
     * that simply is not an agent is not in the list.
     */
    public enum WarningReason {

        /**
         * A symbolic link whose target lies outside the discovery root. Refused
         * unread — the whole point of the containment check.
         */
        ESCAPES_ROOT,

        /**
         * The discovery root itself resolved to a directory outside the Claude
         * directory it is nominally inside — {@code ~/.claude/agents} pointed
         * at {@code ~/.ssh}, say. Not refused: the scan continues, because the
         * point is for the user to see where the directory points, not to stop
         * the sweep. Planting the link takes write access to the Claude
         * directory, which is the same privilege the reading process already
         * has, so this is disclosure, not escalation.
         */
        ROOT_OUTSIDE_CLAUDE_DIR,

        /** A link that could not be resolved: dangling, or removed mid-scan. */
        BROKEN_LINK,

        /**
         * A frontmatter block was present but nothing in it can be trusted.
         * The file stays visible as a non-loadable entry (AC3).
         */
        UNPARSEABLE,

        /** The file could not be listed, read, or stat-ed. */
        UNREADABLE
    }

    /**
     * One discovery root: the directory to scan and the scope to label what is
     * found in it with.
     *
     * @param scope     {@link AgentFields#SCOPE_GLOBAL} or {@link AgentFields#SCOPE_LOCAL}
     * @param directory the {@code agents} directory; it need not exist
     */
    public record ScanRoot(String scope, Path directory) {
    }

    /**
     * A file that looked like an agent candidate.
     *
     * <p>Non-loadable entries are part of the result on purpose: the UI has to
     * be able to say "this file is here and here is why it did not load".
     *
     * @param name     the agent name, or the file stem when the frontmatter
     *                 declared none
     * @param scope    the root it was found under
     * @param path     the resolved file that was read; always inside the root
     * @param loadable whether the frontmatter parsed (PRD R3)
     * @param fields   the frontmatter as JSON, empty when nothing was read
     * @param warning  a human-readable explanation, or null when there is
     *                 nothing to explain
     */
    public record DiscoveredAgent(
            String name,
            String scope,
            Path path,
            boolean loadable,
            JsonObject fields,
            String warning,
            Integer warningLine
    ) {
        /**
         * An entry with no known position for its warning.
         *
         * @param name     the agent name
         * @param scope    the root it was found under
         * @param path     the file that was read
         * @param loadable whether the frontmatter parsed
         * @param fields   the frontmatter
         * @param warning  the explanation
         */
        public DiscoveredAgent(String name, String scope, Path path, boolean loadable,
                               JsonObject fields, String warning) {
            this(name, scope, path, loadable, fields, warning, null);
        }
    }

    /**
     * Something the user may want to be told about, carrying the file name and
     * the reason and nothing else.
     *
     * @param scope    the root the file was found under
     * @param path     the path as it appeared in the directory listing
     * @param fileName the file name alone, which is what a log line may quote
     * @param reason   what went wrong, as a code rather than prose
     * @param message  a short explanation, free of file content
     */
    public record ScanWarning(
            String scope,
            Path path,
            String fileName,
            WarningReason reason,
            String message
    ) {
    }

    /**
     * One pass over one or more roots.
     *
     * @param entries  every candidate that produced an agent or a refused
     *                 frontmatter block, loadable or not
     * @param warnings why files were skipped or refused
     */
    public record ScanResult(List<DiscoveredAgent> entries, List<ScanWarning> warnings) {

        /** The result for "nothing to scan", shared because it is immutable. */
        private static final ScanResult EMPTY = new ScanResult(List.of(), List.of());

        /**
         * The empty result.
         *
         * @return a result with no entries and no warnings
         */
        public static ScanResult empty() {
            return EMPTY;
        }

        /**
         * Only the agents that can actually be loaded.
         *
         * @return the loadable subset, in scan order
         */
        public List<DiscoveredAgent> loadable() {
            return entries.stream().filter(DiscoveredAgent::loadable).toList();
        }

        /**
         * The loadable agents found under one scope.
         *
         * @param scope the scope to filter by
         * @return the matching subset, in scan order
         */
        public List<DiscoveredAgent> loadable(String scope) {
            return entries.stream()
                    .filter(DiscoveredAgent::loadable)
                    .filter(agent -> agent.scope().equals(scope))
                    .toList();
        }
    }

    // ------------------------------------------------------------------
    // Roots
    // ------------------------------------------------------------------

    /**
     * The discovery roots for the current session, with the global home
     * resolved through the WSL-aware resolver.
     *
     * @param workspaceRoot the effective working directory, or null/blank when
     *                      no project is open — in which case only the global
     *                      root is returned
     * @return the roots to scan, global first
     */
    public static List<ScanRoot> roots(String workspaceRoot) {
        return roots(NodeDetector.resolveHomeForFileOps(), workspaceRoot);
    }

    /**
     * The discovery roots for an explicit home directory.
     *
     * <p>Separate from {@link #roots(String)} so the root arithmetic can be
     * tested against a temporary directory instead of the developer's home.
     *
     * @param homeDir       the home directory, or null/blank for no global root
     * @param workspaceRoot the effective working directory, or null/blank for
     *                      no local root
     * @return the roots to scan, global first
     */
    static List<ScanRoot> roots(String homeDir, String workspaceRoot) {
        List<ScanRoot> roots = new ArrayList<>(2);
        if (homeDir != null && !homeDir.isBlank()) {
            roots.add(new ScanRoot(AgentFields.SCOPE_GLOBAL,
                    Paths.get(homeDir, CLAUDE_DIR, AGENTS_DIR)));
        }
        if (workspaceRoot != null && !workspaceRoot.isBlank()) {
            roots.add(new ScanRoot(AgentFields.SCOPE_LOCAL,
                    Paths.get(workspaceRoot, CLAUDE_DIR, AGENTS_DIR)));
        }
        return roots;
    }

    /**
     * The global agents directory, {@code ~/.claude/agents}.
     *
     * @return the path, which need not exist
     */
    public static Path globalRoot() {
        return roots(null).get(0).directory();
    }

    /**
     * The project agents directory, {@code {workspace}/.claude/agents}.
     *
     * @param workspaceRoot the effective working directory
     * @return the path, or null when there is no workspace
     */
    public static Path localRoot(String workspaceRoot) {
        return roots(NodeDetector.resolveHomeForFileOps(), workspaceRoot)
                .stream()
                .filter(root -> AgentFields.SCOPE_LOCAL.equals(root.scope()))
                .map(ScanRoot::directory)
                .findFirst()
                .orElse(null);
    }

    // ------------------------------------------------------------------
    // Scanning
    // ------------------------------------------------------------------

    /**
     * Scan the standard roots for the current session.
     *
     * @param workspaceRoot the effective working directory, or null
     * @return everything found, with both scopes kept apart
     */
    public static ScanResult scanAll(String workspaceRoot) {
        return scan(roots(workspaceRoot));
    }

    /**
     * Scan a given set of roots.
     *
     * @param scanRoots the roots, or null for none
     * @return the merged result; a root that fails does not stop the others
     */
    public static ScanResult scan(List<ScanRoot> scanRoots) {
        if (scanRoots == null || scanRoots.isEmpty()) {
            return ScanResult.empty();
        }
        List<DiscoveredAgent> entries = new ArrayList<>();
        List<ScanWarning> warnings = new ArrayList<>();
        for (ScanRoot root : scanRoots) {
            if (root == null) {
                continue;
            }
            ScanResult result = scanDirectory(root.directory(), root.scope());
            entries.addAll(result.entries());
            warnings.addAll(result.warnings());
        }
        LOG.info("[AgentDiscovery] Scanned " + scanRoots.size() + " root(s): "
                + entries.size() + " agent(s), " + warnings.size() + " warning(s)");
        return new ScanResult(List.copyOf(entries), List.copyOf(warnings));
    }

    /**
     * Scan one {@code agents} directory.
     *
     * <p>Never throws and never writes. A directory that does not exist, cannot
     * be read, or holds nothing usable all produce an empty or partial result.
     *
     * @param directory the {@code agents} directory; need not exist
     * @param scope     the scope to label whatever is found with
     * @return what was found, and what was refused
     */
    public static ScanResult scanDirectory(Path directory, String scope) {
        if (directory == null) {
            return ScanResult.empty();
        }
        // The root is resolved once, and every candidate is checked against the
        // resolved form. Comparing against an unresolved root would reject
        // every file whenever the root itself is reached through a symlink,
        // which on macOS /tmp and /var both are.
        Path root;
        try {
            root = directory.toRealPath();
        } catch (IOException e) {
            // No such directory, or no permission. A machine that has never run
            // Claude Code lands here, and that is not a problem.
            LOG.info("[AgentDiscovery] " + scope + " agents directory unavailable: "
                    + LogSanitizer.sanitize(directory.toString()));
            return ScanResult.empty();
        }
        if (!Files.isDirectory(root)) {
            return ScanResult.empty();
        }

        List<DiscoveredAgent> entries = new ArrayList<>();
        List<ScanWarning> warnings = new ArrayList<>();

        // Reported, never enforced. See rootOutsideClaudeDir.
        ScanWarning escapedRoot = rootOutsideClaudeDir(directory, root, scope);
        if (escapedRoot != null) {
            warnings.add(escapedRoot);
            LOG.warn("[AgentDiscovery] " + scope + " agents directory: "
                    + escapedRoot.message());
        }

        List<Path> candidates = listTopLevel(root);
        if (candidates == null) {
            return new ScanResult(List.of(), List.copyOf(warnings));
        }

        // Real paths already handled, so a symlink alias inside the root
        // collapses onto the file it points at rather than duplicating it.
        Set<Path> read = new HashSet<>();

        for (Path candidate : candidates) {
            String fileName = candidate.getFileName().toString();
            if (!isCandidate(fileName)) {
                continue;
            }
            // The name is attacker-controlled: an agent file can arrive from a
            // cloned repository, and a file name may legally contain a newline
            // or an escape sequence. Interpolated raw into a log line, such a
            // name breaks the line in two and the tail reads as an independent
            // record — enough to forge a plausible-looking warning or, worse, to
            // bury a real one. Every log line that quotes a file name goes
            // through this first.
            String logName = LogSanitizer.sanitize(fileName);

            Path real;
            try {
                real = candidate.toRealPath();
            } catch (IOException e) {
                // A dangling link, or a file removed between the listing and
                // the read. Reported by name only: the failure is the name's.
                String reason = "could not be resolved (a broken symbolic link,"
                        + " or it disappeared during the scan)";
                warnings.add(new ScanWarning(scope, candidate, fileName,
                        WarningReason.BROKEN_LINK, reason));
                LOG.warn("[AgentDiscovery] Skipped " + logName + " in the " + scope
                        + " root: " + reason);
                continue;
            }
            if (!real.startsWith(root)) {
                // The only way a directory entry can leave its own directory is
                // through a link, so this is a symlink escape. Refused before
                // the file is opened: reading it would turn the agents list
                // into an arbitrary-file reader (R14).
                String message = "is a symbolic link pointing outside the " + scope
                        + " agents directory; it was not read";
                warnings.add(new ScanWarning(scope, candidate, fileName,
                        WarningReason.ESCAPES_ROOT, message));
                LOG.warn("[AgentDiscovery] Skipped " + logName + " in the " + scope
                        + " root: " + message);
                continue;
            }
            if (!Files.isRegularFile(real) || !read.add(real)) {
                continue;
            }
            if (!Files.isReadable(real)) {
                // Checked here rather than inferred from the parser's result,
                // which folds "could not open" into the same status as "this
                // file simply has no frontmatter". The two mean different
                // things to a user: a note is fine, a file the plugin cannot
                // read is worth saying out loud. The check is best-effort --
                // an open that still fails is reported by the parser and the
                // file is treated as a non-agent.
                String reason = "is not readable by this process";
                warnings.add(new ScanWarning(scope, real, fileName,
                        WarningReason.UNREADABLE, reason));
                LOG.warn("[AgentDiscovery] Skipped " + logName + " in the " + scope
                        + " root: " + reason);
                continue;
            }

            entries.addAll(read(real, fileName, scope, warnings));
        }

        LOG.info("[AgentDiscovery] " + scope + " root: " + entries.size() + " agent(s), "
                + warnings.size() + " warning(s)");
        return new ScanResult(List.copyOf(entries), List.copyOf(warnings));
    }

    /**
     * Warn when the resolved agents directory is not inside the resolved Claude
     * directory, or null when there is nothing to say.
     *
     * <p><b>Both sides are resolved, and compared component-wise.</b> That is
     * what keeps a legitimate layout quiet: a user who symlinks
     * {@code ~/.claude} itself — to a dotfiles checkout, say — has a resolved
     * Claude directory, and a real {@code agents} directory underneath it
     * resolves into the same hierarchy, so both sides agree and nothing is
     * reported. Comparing the lexical forms would have flagged that setup,
     * which is the reason the check is a warning and not a refusal in the
     * first place.
     *
     * <p>{@link Path#startsWith(Path)} compares name components rather than
     * characters, so a sibling that merely shares a string prefix —
     * {@code ~/.claude-backup} beside {@code ~/.claude} — is correctly
     * reported as outside.
     *
     * <p>A missing or unresolvable Claude directory yields null rather than an
     * error: a machine that has never run Claude Code has no agents directory
     * either and the scan has already returned before reaching this.
     *
     * @param directory the {@code agents} directory as the caller named it
     * @param root      that directory, resolved
     * @param scope     the scope to label the warning with
     * @return the warning, or null when the root is inside its Claude directory
     */
    private static ScanWarning rootOutsideClaudeDir(Path directory, Path root, String scope) {
        Path claudeDir = directory.toAbsolutePath().getParent();
        if (claudeDir == null) {
            return null;
        }
        Path realClaudeDir;
        try {
            realClaudeDir = claudeDir.toRealPath();
        } catch (IOException e) {
            return null;
        }
        if (root.startsWith(realClaudeDir)) {
            return null;
        }
        Path file = directory.getFileName();
        String message = "resolves to " + LogSanitizer.sanitize(root.toString())
                + ", which is outside " + LogSanitizer.sanitize(realClaudeDir.toString())
                + "; it was scanned anyway";
        return new ScanWarning(scope, root,
                file == null ? AGENTS_DIR : file.toString(),
                WarningReason.ROOT_OUTSIDE_CLAUDE_DIR, message);
    }

    /**
     * Parse one already-contained file and turn the outcome into entries.
     *
     * @return the entry, or nothing at all when the file is not an agent
     */
    private static List<DiscoveredAgent> read(Path file, String fileName, String scope,
                                              List<ScanWarning> warnings) {
        SubagentFrontmatterParser.Result parsed = SubagentFrontmatterParser.parse(file);
        if (parsed.status() == SubagentFrontmatterParser.Status.NO_FRONTMATTER) {
            // A reference note. Quietly skipped; see the class javadoc.
            return List.of();
        }
        if (parsed.status() == SubagentFrontmatterParser.Status.UNPARSEABLE) {
            // Kept as a non-loadable entry so the UI can explain it (AC3).
            // The parser's explanation goes to the caller, never to the log:
            // a YAML error quotes the offending line of a file that may hold a
            // system prompt.
            String reason = "frontmatter present but unusable";
            warnings.add(new ScanWarning(scope, file, fileName,
                    WarningReason.UNPARSEABLE, reason));
            LOG.warn("[AgentDiscovery] " + LogSanitizer.sanitize(fileName) + " in the " + scope
                    + " root: " + reason);
            return List.of(new DiscoveredAgent(parsed.name(), scope, file, false,
                    parsed.fields(), parsed.warning(), parsed.warningLine()));
        }
        return List.of(new DiscoveredAgent(parsed.name(), scope, file, true,
                parsed.fields(), parsed.warning()));
    }

    /**
     * The candidate file names in a directory, sorted, or null if it cannot be
     * listed.
     *
     * <p>Sorted so two passes over an unchanged directory report the same
     * order — the merge and precedence steps downstream should not depend on
     * the filesystem's whim.
     */
    private static List<Path> listTopLevel(Path root) {
        List<Path> candidates = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(root)) {
            for (Path entry : stream) {
                candidates.add(entry);
            }
        } catch (IOException e) {
            LOG.warn("[AgentDiscovery] Cannot list agents directory " + LogSanitizer.sanitize(root.toString())
                    + ": " + e.getClass().getSimpleName());
            return null;
        }
        candidates.sort(Comparator.comparing(path -> path.getFileName().toString()));
        return candidates;
    }

    /**
     * Whether a file name is an agent candidate at all.
     *
     * <p>Three filters, all about layout rather than content: the extension, a
     * leading dot, and the reserved documentation names. The reserved-name rule
     * lives in the parser, which owns the list and the reason it exists; it is
     * applied here rather than reimplemented.
     */
    private static boolean isCandidate(String fileName) {
        if (fileName.startsWith(".")) {
            return false;
        }
        if (!fileName.toLowerCase(Locale.ROOT).endsWith(MARKDOWN_EXTENSION)) {
            return false;
        }
        return !SubagentFrontmatterParser.isReservedNonAgentFilename(fileName);
    }
}
