package com.github.claudecodegui.agent;

import com.github.claudecodegui.agent.SubagentDiscoveryScanner.DiscoveredAgent;
import com.github.claudecodegui.agent.SubagentDiscoveryScanner.ScanResult;
import com.github.claudecodegui.agent.SubagentDiscoveryScanner.ScanRoot;
import com.github.claudecodegui.agent.SubagentDiscoveryScanner.ScanWarning;
import com.github.claudecodegui.agent.SubagentDiscoveryScanner.WarningReason;
import com.github.claudecodegui.model.AgentFields;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Behaviour tests for {@link SubagentDiscoveryScanner} (task 58).
 *
 * <p>Three groups of evidence are pinned here.
 *
 * <ol>
 *   <li><b>Scan semantics (PRD R2)</b> — top-level {@code *.md} only, no
 *       recursion, reserved documentation names excluded, both scopes
 *       reported.</li>
 *   <li><b>Failure containment (PRD R4)</b> — a broken frontmatter block, an
 *       unreadable file and a missing directory must never abort the sweep or
 *       hide the healthy agents beside them.</li>
 *   <li><b>Safety (PRD R14, AC6)</b> — a symbolic link that leaves the
 *       discovery root is refused with a warning and is never read, and a full
 *       pass leaves both scanned trees byte-for-byte unchanged.</li>
 * </ol>
 *
 * <p>Every directory used here is a {@link TemporaryFolder}. The developer's
 * real {@code ~/.claude} is never scanned, opened, or written to.
 */
public class SubagentDiscoveryScannerTest {

    /** A minimal but complete agent: the whole file is a few lines. */
    private static final String VALID_AGENT = String.join("\n",
            "---",
            "name: code-reviewer",
            "description: Reviews diffs for correctness",
            "model: sonnet",
            "tools: Read, Grep",
            "---",
            "You review code.",
            "");

    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    // ==================================================================
    // 1. Roots
    // ==================================================================

    /**
     * R1: the two roots are {@code ~/.claude/agents} and
     * {@code {workspace}/.claude/agents}, carrying the scope strings the rest of
     * the plugin already uses. The home is resolved through the WSL-aware
     * resolver, so on a Windows host running a WSL Node it is the UNC form.
     */
    @Test
    public void buildsGlobalAndLocalRootsFromHomeAndWorkspace() throws IOException {
        Path home = temp.newFolder("home").toPath();
        Path workspace = temp.newFolder("workspace").toPath();

        List<ScanRoot> roots = SubagentDiscoveryScanner.roots(home.toString(), workspace.toString());

        assertEquals(2, roots.size());
        assertEquals(AgentFields.SCOPE_GLOBAL, roots.get(0).scope());
        assertEquals(AgentFields.SCOPE_LOCAL, roots.get(1).scope());
        assertEquals(home.resolve(".claude").resolve("agents"), roots.get(0).directory());
        assertEquals(workspace.resolve(".claude").resolve("agents"), roots.get(1).directory());
    }

    /**
     * A project with no resolvable working directory still gets the global root;
     * the local root is simply absent rather than present-and-null, so a caller
     * iterating the roots cannot dereference nothing.
     */
    @Test
    public void omitsLocalRootWhenThereIsNoWorkspace() throws IOException {
        Path home = temp.newFolder("home").toPath();

        List<ScanRoot> onlyGlobal = SubagentDiscoveryScanner.roots(home.toString(), null);
        assertEquals(1, onlyGlobal.size());
        assertEquals(AgentFields.SCOPE_GLOBAL, onlyGlobal.get(0).scope());

        List<ScanRoot> neither = SubagentDiscoveryScanner.roots(null, "  ");
        assertTrue(neither.isEmpty());
    }

    /**
     * The public root builder goes through {@code NodeDetector.resolveHomeForFileOps()},
     * never {@code System.getProperty("user.home")}. Calling it here only
     * builds path strings — the developer's home directory is not read.
     */
    @Test
    public void publicRootBuilderResolvesGlobalRootUnderClaudeAgents() {
        List<ScanRoot> roots = SubagentDiscoveryScanner.roots(null);

        assertEquals(1, roots.size());
        ScanRoot global = roots.get(0);
        assertEquals(AgentFields.SCOPE_GLOBAL, global.scope());
        assertEquals("agents", global.directory().getFileName().toString());
        assertEquals(".claude", global.directory().getParent().getFileName().toString());
    }

    // ==================================================================
    // 2. Scan semantics (R2)
    // ==================================================================

    /** A valid agent in the root directory is found, with its fields and scope. */
    @Test
    public void findsValidAgentInRootDirectory() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(1, result.loadable().size());
        DiscoveredAgent agent = result.loadable().get(0);
        assertEquals("code-reviewer", agent.name());
        assertEquals(AgentFields.SCOPE_GLOBAL, agent.scope());
        assertEquals(root.resolve("code-reviewer.md").toRealPath(), agent.path());
        JsonObject fields = agent.fields();
        assertEquals("Reviews diffs for correctness", fields.get("description").getAsString());
        assertEquals("sonnet", fields.get("model").getAsString());
    }

    /** The same file discovered under the project root reports scope "local". */
    @Test
    public void reportsLocalScopeForTheWorkspaceRoot() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_LOCAL);

        assertEquals(1, result.loadable().size());
        assertEquals(AgentFields.SCOPE_LOCAL, result.loadable().get(0).scope());
    }

    /**
     * R2: no recursion. A subdirectory holding a perfectly valid agent is
     * invisible to the scan, because Claude Code does not load it either and
     * showing it would promise something the runtime will not do.
     */
    @Test
    public void doesNotRecurseIntoSubdirectories() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);
        Path nested = Files.createDirectories(root.resolve("nested"));
        write(nested.resolve("deep-agent.md"), VALID_AGENT.replace("code-reviewer", "deep-agent"));

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("code-reviewer"), names(result.loadable()));
        // The directory entry itself is not reported as a broken agent either.
        assertTrue("unexpected warnings: " + result.warnings(), result.warnings().isEmpty());
    }

    /** Only {@code *.md} counts; the extension test is case-insensitive. */
    @Test
    public void ignoresFilesThatAreNotMarkdown() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("notes.txt"), VALID_AGENT);
        write(root.resolve("agent.markdown"), VALID_AGENT);
        write(root.resolve("agent"), VALID_AGENT);
        write(root.resolve("agent.MD"), VALID_AGENT.replace("code-reviewer", "upper-ext"));

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("upper-ext"), names(result.loadable()));
    }

    /**
     * A directory whose name ends in {@code .md} is not an agent. The parser
     * would refuse it anyway; the scanner skips it before opening anything.
     */
    @Test
    public void ignoresDirectoriesNamedLikeMarkdownFiles() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("real-agent.md"), VALID_AGENT.replace("code-reviewer", "real-agent"));
        Files.createDirectories(root.resolve("looks-like-an-agent.md"));

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("real-agent"), names(result.loadable()));
    }

    /**
     * R4 / the parser's reserved-name rule: {@code README.md} and
     * {@code SKILL.md} sit in real agents directories and carry frontmatter,
     * but neither is an agent. {@code SKILL.md} is the sharp case — its
     * declared name collides with a real {@code workflow-patterns.md} beside
     * it, so accepting it would put two artifacts in a name fight.
     */
    @Test
    public void skipsReservedDocumentationFileNames() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);
        write(root.resolve("README.md"), "# Agents\n\nNotes, not an agent.\n");
        write(root.resolve("SKILL.md"), "---\nname: code-reviewer\ndescription: a skill\n---\nbody\n");
        write(root.resolve("CLAUDE.md"), "---\nname: claude-md\n---\nbody\n");
        write(root.resolve("CHANGELOG.md"), "---\nname: changelog\n---\nbody\n");
        write(root.resolve("readme.md"), "---\nname: lowercase-readme\n---\nbody\n");

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("code-reviewer"), names(result.loadable()));
        assertTrue("reserved names must not surface as warnings",
                result.warnings().isEmpty());
    }

    /** Hidden files are skipped, matching the skills scan. */
    @Test
    public void ignoresHiddenFiles() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);
        write(root.resolve(".hidden-agent.md"), VALID_AGENT.replace("code-reviewer", "hidden"));

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("code-reviewer"), names(result.loadable()));
    }

    /**
     * Both roots are scanned and the scopes are kept apart for the merge step.
     * The roots are built from a temporary home, so the developer's real
     * {@code ~/.claude/agents} is never read.
     */
    @Test
    public void scansBothRootsInOnePass() throws IOException {
        Path home = temp.newFolder("home").toPath();
        Path global = Files.createDirectories(home.resolve(".claude").resolve("agents"));
        write(global.resolve("shared.md"), VALID_AGENT.replace("code-reviewer", "shared-global"));
        Path workspace = temp.newFolder("workspace").toPath();
        Path local = Files.createDirectories(workspace.resolve(".claude").resolve("agents"));
        write(local.resolve("shared.md"), VALID_AGENT.replace("code-reviewer", "shared-local"));
        write(local.resolve("project-only.md"), VALID_AGENT.replace("code-reviewer", "project-only"));

        ScanResult result = SubagentDiscoveryScanner.scan(
                SubagentDiscoveryScanner.roots(home.toString(), workspace.toString()));

        assertEquals(3, result.loadable().size());
        assertEquals(List.of("shared-global"),
                names(result.loadable().stream()
                        .filter(a -> AgentFields.SCOPE_GLOBAL.equals(a.scope())).toList()));
        assertEquals(List.of("project-only", "shared-local"),
                names(result.loadable().stream()
                        .filter(a -> AgentFields.SCOPE_LOCAL.equals(a.scope())).toList()));
    }

    // ==================================================================
    // 3. Failure containment (R4)
    // ==================================================================

    /**
     * A file with an unterminated frontmatter block must not abort the sweep.
     * The other agents are still found, and the broken one is reported as a
     * non-loadable entry carrying the parser's own explanation — PRD AC3 wants
     * the user to see <em>why</em>, not to find the agent silently missing.
     */
    @Test
    public void brokenFrontmatterDoesNotAbortTheSweep() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("healthy.md"), VALID_AGENT.replace("code-reviewer", "healthy"));
        write(root.resolve("broken.md"), "---\nname: broken\ndescription: never closed\n");
        write(root.resolve("invalid-yaml.md"), "---\nname: [unclosed\n---\nbody\n");
        write(root.resolve("healthy-two.md"), VALID_AGENT.replace("code-reviewer", "healthy-two"));

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("healthy", "healthy-two"), names(result.loadable()));
        assertEquals("the broken files must stay visible as non-loadable entries",
                2, result.entries().size() - result.loadable().size());
        assertTrue(names(result.loadable()).stream()
                .noneMatch(n -> n.equals("broken") || n.equals("invalid-yaml")));

        for (DiscoveredAgent agent : result.entries()) {
            if (!agent.loadable()) {
                assertFalse("a non-loadable entry must explain itself",
                        agent.warning() == null || agent.warning().isBlank());
                assertEquals(AgentFields.SCOPE_GLOBAL, agent.scope());
                assertNotNull(agent.path());
            }
        }
        assertTrue(reasons(result).contains(WarningReason.UNPARSEABLE));
    }

    /**
     * A file with no frontmatter is a reference note — 122 of the 274 real
     * files in the developer's directory are exactly this. It is skipped
     * quietly: a note is not a problem, and warning about it would drown the
     * warnings that matter.
     */
    @Test
    public void filesWithoutFrontmatterAreSkippedQuietly() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("notes.md"), "Just a note, no frontmatter here.\n");
        write(root.resolve("code-reviewer.md"), VALID_AGENT);

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("code-reviewer"), names(result.loadable()));
        assertTrue("a note is not a warning: " + result.warnings(), result.warnings().isEmpty());
    }

    /**
     * An unreadable file must not take the sweep down with it. On a platform
     * where the test runs as a user that can read anything despite the mode
     * bits, the file simply parses; the assertion that matters — no exception,
     * neighbours still found — holds either way.
     */
    @Test
    public void unreadableFileDoesNotAbortTheSweep() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("healthy.md"), VALID_AGENT.replace("code-reviewer", "healthy"));
        Path locked = root.resolve("locked.md");
        write(locked, VALID_AGENT.replace("code-reviewer", "locked"));
        assertTrue(locked.toFile().setReadable(false, false));

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("healthy"), names(result.loadable()));
        assertTrue("the locked file is reported, not silently dropped",
                result.entries().stream().anyMatch(a -> a.name().equals("locked"))
                        || reasons(result).contains(WarningReason.UNREADABLE));
    }

    /** A machine with no {@code .claude/agents} anywhere is the normal case. */
    @Test
    public void missingDirectoryYieldsAnEmptyResultWithoutThrowing() {
        Path absent = temp.getRoot().toPath().resolve("nope").resolve(".claude").resolve("agents");

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(absent, AgentFields.SCOPE_GLOBAL);

        assertNotNull(result);
        assertTrue(result.entries().isEmpty());
        assertTrue(result.warnings().isEmpty());
        assertTrue(result.loadable().isEmpty());
    }

    @Test
    public void nullDirectoryYieldsAnEmptyResult() {
        assertTrue(SubagentDiscoveryScanner.scanDirectory(null, AgentFields.SCOPE_GLOBAL)
                .entries().isEmpty());
    }

    /** A null root list is a legitimate "nothing to scan" answer, not a crash. */
    @Test
    public void nullRootListYieldsAnEmptyResult() {
        assertTrue(SubagentDiscoveryScanner.scan(null).entries().isEmpty());
    }

    // ==================================================================
    // 4. Safety (R14, AC6)
    // ==================================================================

    /**
     * The load-bearing security test. A symbolic link in the agents directory
     * that points at a file outside every discovery root must never be read:
     * otherwise a planted link turns the agents list into an arbitrary-file
     * reader over the user's home directory.
     */
    @Test
    public void symlinkPointingOutsideTheRootIsRefusedWithAWarning() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);

        // The target lives outside every discovery root, in a sibling of root.
        Path outside = temp.newFolder("outside").toPath();
        Path secret = outside.resolve("stolen.md");
        write(secret, VALID_AGENT.replace("code-reviewer", "stolen"));

        Path link = root.resolve("leak.md");
        try {
            Files.createSymbolicLink(link, outside.resolve("stolen.md"));
        } catch (IOException | UnsupportedOperationException e) {
            // Windows without developer mode, or a filesystem without symlinks.
            return;
        }

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals("only the real agent may be loaded",
                List.of("code-reviewer"), names(result.loadable()));
        assertTrue("the escaping file must not appear as an agent",
                names(result.entries()).stream().noneMatch("stolen"::equals));

        List<ScanWarning> escapes = result.warnings().stream()
                .filter(w -> w.reason() == WarningReason.ESCAPES_ROOT)
                .toList();
        assertEquals("expected exactly one escape warning, got: " + result.warnings(),
                1, escapes.size());
        ScanWarning warning = escapes.get(0);
        assertEquals("leak.md", warning.fileName());
        assertEquals(AgentFields.SCOPE_GLOBAL, warning.scope());
        // The warning reports the name and the reason; never the file contents.
        assertTrue(warning.message(), warning.message().contains("outside"));
        assertFalse("a warning must not quote the target's content",
                warning.message().contains("stolen"));

        // Belt and braces: nothing the scan reports may point outside the root.
        Path realRoot = root.toRealPath();
        for (DiscoveredAgent agent : result.entries()) {
            assertTrue("entry escaped the root: " + agent.path(),
                    agent.path().startsWith(realRoot));
        }
    }

    /**
     * A link that stays inside the root is not a threat, so it is allowed — and
     * it collapses onto the file it points at instead of producing a second
     * entry for the same bytes.
     */
    @Test
    public void symlinkInsideTheRootIsFollowedButNotDoubleCounted() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("real-agent.md"), VALID_AGENT.replace("code-reviewer", "real-agent"));
        Path alias = root.resolve("a-alias.md");
        try {
            Files.createSymbolicLink(alias, root.resolve("real-agent.md"));
        } catch (IOException | UnsupportedOperationException e) {
            return;
        }

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals("an alias must not yield a second agent for the same file",
                List.of("real-agent"), names(result.loadable()));
        assertTrue("unexpected warnings: " + result.warnings(), result.warnings().isEmpty());
    }

    /** A link to nowhere is reported, not thrown. */
    @Test
    public void brokenSymlinkIsReportedAsAWarning() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);
        try {
            Files.createSymbolicLink(root.resolve("dangling.md"), root.resolve("gone.md"));
        } catch (IOException | UnsupportedOperationException e) {
            return;
        }

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("code-reviewer"), names(result.loadable()));
        assertTrue(reasons(result).contains(WarningReason.BROKEN_LINK));
    }

    /**
     * AC6: discovery is read-only. A full pass over both roots must leave them
     * byte-identical — same entries, same sizes, same modification times.
     */
    @Test
    public void discoveryNeverWritesToTheScannedDirectories() throws IOException {
        Path root = agentsRoot();
        write(root.resolve("code-reviewer.md"), VALID_AGENT);
        write(root.resolve("broken.md"), "---\nname: broken\n");
        write(root.resolve("notes.md"), "no frontmatter\n");
        write(root.resolve("README.md"), "# readme\n");
        Files.createDirectories(root.resolve("nested"));
        Path workspace = temp.newFolder("workspace").toPath();
        Path localRoot = Files.createDirectories(workspace.resolve(".claude").resolve("agents"));
        write(localRoot.resolve("project.md"), VALID_AGENT.replace("code-reviewer", "project"));
        Path outside = temp.newFolder("outside").toPath();
        write(outside.resolve("secret.md"), VALID_AGENT);

        Map<String, String> before = snapshot(root, localRoot, outside);
        SubagentDiscoveryScanner.scanDirectory(root, AgentFields.SCOPE_GLOBAL);
        SubagentDiscoveryScanner.scanDirectory(localRoot, AgentFields.SCOPE_LOCAL);
        Map<String, String> after = snapshot(root, localRoot, outside);

        assertEquals("discovery modified the filesystem it scans", before, after);
    }

    // ==================================================================
    // 5. Root containment
    // ==================================================================

    /**
     * A root reached through a symlink resolves to somewhere else entirely,
     * and every containment check <em>inside</em> it then passes — the files
     * really are under the resolved root. So the scan must not go quiet: the
     * agent is found, and a warning says where the directory actually points.
     *
     * <p>The load-bearing half is the first assertion. Refusing the root would
     * be the easy fix and the wrong one: the user gets an empty list and no
     * explanation, which is indistinguishable from "I have no agents". A
     * warning next to a populated list answers the question they were asking.
     */
    @Test
    public void agentsRootSymlinkedOutsideClaudeDirIsWarnedAboutButStillScanned() throws IOException {
        Path home = temp.newFolder("home").toPath();
        Path claudeDir = Files.createDirectories(home.resolve(".claude"));
        Path outside = temp.newFolder("elsewhere").toPath();
        write(outside.resolve("planted.md"), VALID_AGENT.replace("code-reviewer", "planted"));

        Path link = claudeDir.resolve("agents");
        try {
            Files.createSymbolicLink(link, outside);
        } catch (IOException | UnsupportedOperationException e) {
            return;
        }

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(link, AgentFields.SCOPE_GLOBAL);

        assertEquals("the scan must continue and report what the link exposes",
                List.of("planted"), names(result.loadable()));
        assertEquals(outside.toRealPath().resolve("planted.md"),
                result.loadable().get(0).path());

        List<ScanWarning> escaped = result.warnings().stream()
                .filter(w -> w.reason() == WarningReason.ROOT_OUTSIDE_CLAUDE_DIR)
                .toList();
        assertEquals("expected exactly one root warning, got: " + result.warnings(),
                1, escaped.size());
        ScanWarning warning = escaped.get(0);
        assertEquals(AgentFields.SCOPE_GLOBAL, warning.scope());
        // The message must name where it points, or it is not actionable.
        assertTrue(warning.message(), warning.message().contains(outside.toRealPath().toString()));
        assertTrue(warning.message(), warning.message().contains(claudeDir.toRealPath().toString()));
    }

    /**
     * The legitimate layout the check must not punish: the user symlinks
     * {@code ~/.claude} itself, to a dotfiles checkout say, and {@code agents}
     * is a genuine directory underneath. The lexical paths diverge, the
     * resolved ones do not — so this scans with no warning at all.
     *
     * <p>This is the assertion that keeps the feature a warning rather than a
     * refusal. Compare the lexical forms and this setup is rejected.
     */
    @Test
    public void claudeDirItselfSymlinkedIsNotWarnedAbout() throws IOException {
        Path home = temp.newFolder("home").toPath();
        Path real = temp.newFolder("dotfiles").toPath();
        Path agents = Files.createDirectories(real.resolve("agents"));
        write(agents.resolve("code-reviewer.md"), VALID_AGENT);

        Path claudeLink = home.resolve(".claude");
        try {
            Files.createSymbolicLink(claudeLink, real);
        } catch (IOException | UnsupportedOperationException e) {
            return;
        }

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(
                claudeLink.resolve("agents"), AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("code-reviewer"), names(result.loadable()));
        assertTrue("a user's own ~/.claude symlink is not an escape: " + result.warnings(),
                result.warnings().isEmpty());
    }

    /**
     * Containment is decided per path component, not per character. A sibling
     * directory whose name merely starts with the Claude directory's name is a
     * different directory, and a string-prefix test would wave it through.
     */
    @Test
    public void aSiblingSharingTheClaudeDirStringPrefixIsStillOutside() throws IOException {
        Path home = temp.newFolder("home").toPath();
        Path claudeDir = Files.createDirectories(home.resolve(".claude"));
        Path sibling = Files.createDirectories(home.resolve(".claude-backup"));
        write(sibling.resolve("planted.md"), VALID_AGENT.replace("code-reviewer", "planted"));

        Path link = claudeDir.resolve("agents");
        try {
            Files.createSymbolicLink(link, sibling);
        } catch (IOException | UnsupportedOperationException e) {
            return;
        }

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(link, AgentFields.SCOPE_GLOBAL);

        assertEquals(List.of("planted"), names(result.loadable()));
        assertTrue("a shared string prefix is not containment",
                reasons(result).contains(WarningReason.ROOT_OUTSIDE_CLAUDE_DIR));
    }

    /**
     * A machine with no {@code .claude} anywhere is the normal starting state,
     * and the root comparison must not turn that into a warning — there is
     * nothing to compare against, and inventing one would fill the warnings
     * list of every fresh install.
     */
    @Test
    public void missingClaudeDirectoryProducesNoWarningOfItsOwn() {
        Path absent = temp.getRoot().toPath().resolve("never-created")
                .resolve(".claude").resolve("agents");

        ScanResult result = SubagentDiscoveryScanner.scanDirectory(absent, AgentFields.SCOPE_GLOBAL);

        assertTrue(result.entries().isEmpty());
        assertTrue("an absent directory is not a warning: " + result.warnings(),
                result.warnings().isEmpty());
    }

    // ==================================================================
    // Helpers
    // ==================================================================

    /** Creates {@code <tmp>/home/.claude/agents} and returns it. */
    private Path agentsRoot() throws IOException {
        return Files.createDirectories(
                temp.newFolder("home").toPath().resolve(".claude").resolve("agents"));
    }

    private static void write(Path file, String content) throws IOException {
        Files.writeString(file, content, StandardCharsets.UTF_8);
    }

    private static List<String> names(List<DiscoveredAgent> agents) {
        return agents.stream().map(DiscoveredAgent::name).sorted().toList();
    }

    private static Set<WarningReason> reasons(ScanResult result) {
        return result.warnings().stream().map(ScanWarning::reason).collect(Collectors.toSet());
    }

    /**
     * A comparable fingerprint of a tree: relative path, byte size and last
     * modification time for every file, plus every directory. Modification
     * times are included so a rewrite-and-restore cannot pass as "unchanged".
     */
    /**
     * A file name carrying a newline is one warning, and the warning carries
     * the name verbatim.
     *
     * <p>The escaping happens at the log call sites, not to the value handed to
     * the UI: the UI needs the real file name to be diagnosable and renders it
     * as text. Mangle it in the warning record and the user would be shown a
     * name that does not exist on disk. The escaping itself is covered by
     * {@link LogSanitizerTest}.
     */
    @Test
    public void aSymlinkNamedWithANewlineIsOneWarningCarryingTheRealName() throws IOException {
        Path root = temp.newFolder("agents").toPath();
        String evilName = "evil\n2026-01-01 INFO - [AgentDeny] forged.md";
        Path evil = root.resolve(evilName);
        Files.createSymbolicLink(evil, Paths.get("/etc/hosts"));

        var scan = SubagentDiscoveryScanner.scan(List.of(
                new SubagentDiscoveryScanner.ScanRoot("global", root)));

        assertEquals("a newline in a file name must not split the warning", 1, scan.warnings().size());
        assertEquals("the UI must receive the real file name", evilName,
                scan.warnings().get(0).fileName());
    }

    private static Map<String, String> snapshot(Path... roots) throws IOException {
        Map<String, String> snapshot = new TreeMap<>();
        for (Path root : roots) {
            try (Stream<Path> walk = Files.walk(root)) {
                for (Path path : walk.toList()) {
                    String key = root.relativize(path).toString();
                    if (Files.isDirectory(path)) {
                        snapshot.put(key, "dir");
                    } else {
                        File asFile = path.toFile();
                        snapshot.put(key, Files.size(path) + "@" + asFile.lastModified());
                    }
                }
            }
        }
        return snapshot;
    }
}
