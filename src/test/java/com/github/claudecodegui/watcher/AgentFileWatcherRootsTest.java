package com.github.claudecodegui.watcher;

import org.junit.Test;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Which VFS paths count as a change to a discovered agent.
 *
 * <p>Everything below tests the path predicate rather than the subscription:
 * a false positive costs one wasted rescan and nothing else, because the rescan
 * applies the real containment checks. What must not go wrong is a false
 * <em>negative</em> — a real agent file the watcher ignores — since that is the
 * case the feature exists to fix.
 *
 * <p>Roots come from {@code NodeDetector.resolveHomeForFileOps()}, so these
 * cases are expressed as "is this path a direct child of a root" rather than
 * pinning the developer's home directory.
 */
public class AgentFileWatcherRootsTest {

    /**
     * The watcher's own predicate.
     *
     * <p>Called directly rather than mirrored: a copy of this rule would keep
     * passing after the implementation changed, which is the one thing a test
     * here must not do. It is package-private for exactly this reason — the
     * path decision is worth pinning and the VFS subscription around it is not.
     */
    private static boolean isAgentFile(String filePath, boolean isDirectory, List<Path> roots) {
        return AgentFileWatcher.isAgentFilePath(filePath, isDirectory, roots);
    }

    /** The two roots, spelled out so the test does not read the developer's home. */
    private static List<Path> roots() {
        return List.of(
                Path.of("/home/u/.claude/agents"),
                Path.of("/work/proj/.claude/agents"));
    }

    // ------------------------------------------------------------------
    // Should fire
    // ------------------------------------------------------------------

    @Test
    public void aTopLevelAgentFileInEitherRootIsAChange() {
        assertTrue(isAgentFile("/home/u/.claude/agents/code-reviewer.md", false, roots()));
        assertTrue(isAgentFile("/work/proj/.claude/agents/local-helper.md", false, roots()));
    }

    /**
     * The extension check is case-insensitive, because it must be: the file
     * filter discovery uses is case-insensitive too, so an agent saved as
     * {@code REVIEWER.MD} is listed by a scan but would be ignored by a
     * case-sensitive watcher, and the two would disagree.
     */
    @Test
    public void theExtensionCheckIsCaseInsensitiveLikeDiscoverys() {
        assertTrue(isAgentFile("/home/u/.claude/agents/REVIEWER.MD", false, roots()));
        assertTrue(isAgentFile("/home/u/.claude/agents/Reviewer.Md", false, roots()));
    }

    /**
     * The root comparison is case-insensitive for the same reason, and it is
     * the half that actually goes wrong in the field.
     *
     * <p>On a case-insensitive filesystem — the default on macOS and Windows —
     * the VFS reports a directory the way it is stored on disk, which need not
     * be the spelling {@code NodeDetector} produced for the root. A
     * {@code Path.equals} comparison sees two different paths, the watcher
     * stays quiet, and the settings list keeps showing the pre-edit contents
     * until the tab is reopened. Discovery, which reaches the same directory
     * through {@code java.nio}, lists the file; the watcher must agree with it.
     */
    @Test
    public void theRootComparisonIsCaseInsensitiveLikeTheFileSystem() {
        // Root as configured, event as the filesystem spells it.
        assertTrue(isAgentFile("/HOME/U/.CLAUDE/AGENTS/code-reviewer.md", false, roots()));
        assertTrue(isAgentFile("/Work/Proj/.Claude/Agents/local-helper.md", false, roots()));
        // And the other way round, for a root built from the disk spelling.
        assertTrue(isAgentFile("/home/u/.claude/agents/code-reviewer.md", false,
                List.of(Path.of("/HOME/U/.CLAUDE/AGENTS"))));
    }

    /**
     * Folding case must not turn the containment check into a prefix one.
     *
     * <p>This is the direction normalisation could plausibly break: a
     * comparison that only checked "does the parent start with the root" would
     * happily accept {@code /home/u/.claude/agents-archive}, which is a
     * different directory that discovery never scans. Equality on the folded
     * form keeps those apart.
     */
    @Test
    public void aDirectoryThatMerelySharesTheRootsPrefixIsStillNotAChange() {
        assertFalse(isAgentFile("/home/u/.claude/agents-archive/code-reviewer.md", false, roots()));
        assertFalse(isAgentFile("/home/u/.claude/agents-archive/REVIEWER.MD", false, roots()));
        assertFalse(isAgentFile("/work/proj/.claude/agents-old/local-helper.md", false, roots()));
        // A prefix in the other direction: a root is not a child of the event's
        // directory either.
        assertFalse(isAgentFile("/home/u/.claude/agents.md", false, roots()));
    }

    // ------------------------------------------------------------------
    // Should not fire
    // ------------------------------------------------------------------

    /**
     * Discovery is non-recursive, so a nested document is not in the list and a
     * change to it must not cost a rescan.
     */
    @Test
    public void aNestedFileIsNotAChange() {
        assertFalse(isAgentFile("/home/u/.claude/agents/nested/deep.md", false, roots()));
    }

    @Test
    public void aFileOutsideEveryRootIsNotAChange() {
        assertFalse(isAgentFile("/etc/passwd.md", false, roots()));
        assertFalse(isAgentFile("/home/u/.claude/settings.json", false, roots()));
        assertFalse(isAgentFile("/work/other/.claude/agents/x.md", false, roots()));
    }

    @Test
    public void aNonMarkdownFileIsNotAChange() {
        assertFalse(isAgentFile("/home/u/.claude/agents/notes.txt", false, roots()));
        assertFalse(isAgentFile("/home/u/.claude/agents/config.yaml", false, roots()));
        assertFalse(isAgentFile("/home/u/.claude/agents/archive.markdown", false, roots()));
    }

    /**
     * A directory whose name ends in {@code .md} would otherwise be
     * indistinguishable from a document, and firing on it would rescan on an
     * unrelated filesystem event.
     */
    @Test
    public void aDirectoryNamedLikeAMarkdownFileIsNotAChange() {
        assertFalse(isAgentFile("/home/u/.claude/agents/bundle.md", true, roots()));
    }

    /** No roots means no home and no workspace; the watcher must simply stay quiet. */
    @Test
    public void anEmptyRootListMatchesNothing() {
        assertFalse(isAgentFile("/home/u/.claude/agents/code-reviewer.md", false, List.of()));
    }

    /**
     * A path with no parent is a bare relative name. Resolving it against a
     * root would make it look like a match, which is exactly the kind of guess
     * the containment rules elsewhere in this feature refuse to make.
     */
    @Test
    public void aPathWithNoParentIsNotAChange() {
        assertFalse(isAgentFile("code-reviewer.md", false, roots()));
    }

    // ------------------------------------------------------------------
    // The roots themselves
    // ------------------------------------------------------------------

    /**
     * The roots are the agents directories, not their parents. Comparing
     * against {@code .claude} instead would make a change to any other file
     * beside them — settings.json, a CLAUDE.md — look like an agent change.
     */
    @Test
    public void theComparedPathIsTheAgentsDirectoryItself() {
        assertEquals(Path.of("/home/u/.claude/agents"),
                Path.of("/home/u/.claude/agents/code-reviewer.md").getParent());
        assertFalse(isAgentFile("/home/u/.claude/CLAUDE.md", false, roots()));
        assertFalse(isAgentFile("/home/u/.claude/settings.json", false, roots()));
    }
}