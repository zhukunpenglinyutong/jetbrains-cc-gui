package com.github.claudecodegui.watcher;

import com.github.claudecodegui.bridge.NodeDetector;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.util.concurrency.AppExecutorUtil;
import com.intellij.util.messages.MessageBusConnection;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * Watches the two Claude Code agent roots and reports that they changed.
 *
 * <p>Exists because discovery itself is deliberately uncached: the settings tab
 * asks for the list once when it is opened, and without something like this an
 * edit made in the editor — a name typed, a field corrected — would not reach
 * the open tab at all. Without it the list is right when you open Settings and
 * wrong for as long as you leave it open.
 *
 * <h2>What it does and does not do</h2>
 *
 * <p>It only answers "did something inside a discovery root change". It does not
 * read the file, does not parse it, and does not build a list. The rescan stays
 * where the containment checks live — {@code get_agents} — and this class merely
 * asks for it. That split is the point: a change detector that went on to read
 * the changed file would be a second, less careful path to the same bytes, and
 * the one place that decides what is safe to read would no longer be the only
 * one.
 *
 * <p>Roots are resolved on every event rather than captured at construction. The
 * workspace can be repointed at a custom working directory while the window is
 * open, and a watcher holding the roots it was built with would keep watching
 * the directory the user has since left.
 *
 * <h2>Debouncing</h2>
 *
 * <p>Editor saves arrive in bursts — a write, then several as the IDE settles
 * file state — and each one would otherwise trigger a rescan of a few hundred
 * files. Events inside the window collapse into a single notification. The
 * schedule is on the pooled executor rather than the VFS thread, so the editor
 * is not held up by the debounce.
 */
public class AgentFileWatcher implements BulkFileListener {

    private static final Logger LOG = Logger.getInstance(AgentFileWatcher.class);

    /** The Claude directory, and the agents directory inside it. */
    private static final String CLAUDE_DIR = ".claude";
    private static final String AGENTS_DIR = "agents";
    private static final String MARKDOWN_EXTENSION = ".md";

    /**
     * How long to keep collecting before reporting, in milliseconds.
     *
     * <p>Long enough to swallow a save and the follow-up events the IDE raises
     * around it, short enough that a user who saves and looks back at Settings
     * sees the result rather than a stale row.
     */
    private static final long DEBOUNCE_MS = 400;

    private final Project project;
    private final Supplier<String> workspaceRootSupplier;

    /**
     * Called, off the VFS thread, once per debounce window in which something
     * inside a discovery root changed.
     */
    private final Runnable onChanged;

    /** Guards the debounce so a burst produces one notification, not one per event. */
    private final AtomicBoolean pending = new AtomicBoolean(false);

    private MessageBusConnection connection;

    /**
     * @param project               the project whose VFS bus to subscribe to
     * @param workspaceRootSupplier supplies the effective working directory, read
     *                               fresh each time so a reconfigured working
     *                               directory is followed
     * @param onChanged             invoked on the pooled executor after the
     *                               debounce window
     */
    public AgentFileWatcher(Project project,
                            Supplier<String> workspaceRootSupplier,
                            Runnable onChanged) {
        this.project = project;
        this.workspaceRootSupplier = workspaceRootSupplier;
        this.onChanged = onChanged;
    }

    @Override
    public void after(List<? extends VFileEvent> events) {
        if (events == null || events.isEmpty()) {
            return;
        }
        List<Path> roots = currentRoots();
        for (VFileEvent event : events) {
            VirtualFile file = event.getFile();
            if (file != null && isAgentFilePath(file.getPath(), file.isDirectory(), roots)) {
                scheduleNotify();
                return;
            }
        }
    }

    /**
     * Whether a changed path is one discovery would have looked at.
     *
     * <p>A direct child of a root, ending in {@code .md}. A false positive costs
     * one wasted rescan and nothing else — the rescan applies the real
     * containment checks — so the test stays cheap and this stays simple. A
     * false <em>negative</em> is the expensive direction, and is what the cases
     * below pin: the extension comparison is case-insensitive because
     * discovery's own filter is, and the root comparison is too, because on a
     * case-insensitive filesystem — the default on macOS and Windows — the
     * scanner and the watcher can be handed the same directory spelled
     * differently. A watcher that disagreed would miss a file the scan lists,
     * and the settings list would go stale until it was reopened.
     *
     * <p>Takes a path rather than a {@link VirtualFile} so the rule is directly
     * testable without the platform fixtures.
     *
     * @param path       the VFS path of the changed file
     * @param isDirectory whether that path is a directory
     * @param roots      the discovery roots, as of this event
     * @return true when the change is one discovery cares about
     */
    static boolean isAgentFilePath(String path, boolean isDirectory, List<Path> roots) {
        // A directory named agents/ is not a file inside it, and a `.md`
        // directory would otherwise be indistinguishable from a document.
        if (isDirectory) {
            return false;
        }
        Path file = Paths.get(path);
        Path fileName = file.getFileName();
        if (fileName == null
                || !fileName.toString().toLowerCase(Locale.ROOT).endsWith(MARKDOWN_EXTENSION)) {
            return false;
        }
        Path parent = file.getParent();
        if (parent == null) {
            // A bare relative name. Resolving it against a root here would be
            // the kind of guess the containment rules elsewhere refuse.
            return false;
        }
        // Compared against the root itself, not the root's parent: discovery is
        // non-recursive, so only a top-level document is its business.
        //
        // On a case-insensitive filesystem the VFS can hand back the same
        // directory the root was built from with its case as stored on disk,
        // which differs from the spelling NodeDetector and the working
        // directory produced. Path.equals compares the path element by element,
        // so it would call that a non-match and the watcher would sit quiet
        // while discovery listed the file. Normalising the comparison key
        // fixes that without touching the filesystem: the equality is still
        // exact on the normalised form, never a prefix test, and no path is
        // resolved or rewritten to make it match.
        String parentKey = comparisonKey(parent);
        for (Path root : roots) {
            if (root != null && comparisonKey(root).equals(parentKey)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The form two paths are compared in.
     *
     * <p>Case folding with {@link Locale#ROOT}, matching discovery's own
     * filter. Only the comparison key is normalised; the paths themselves are
     * untouched, so a root that differs from the event by more than case still
     * fails to match.
     *
     * @param path the path to key
     * @return the folded form used for equality
     */
    private static String comparisonKey(Path path) {
        return path.toString().toLowerCase(Locale.ROOT);
    }

    /**
     * The two roots, resolved now.
     *
     * <p>{@code ~/.claude/agents} always, plus the effective project's
     * {@code .claude/agents} when there is one. A missing directory yields a
     * root that simply never matches, matching discovery: the tab has to work
     * on a machine that has never run Claude Code.
     */
    private List<Path> currentRoots() {
        List<Path> roots = new ArrayList<>(2);

        String home = NodeDetector.resolveHomeForFileOps();
        if (home != null && !home.isBlank()) {
            roots.add(Paths.get(home, CLAUDE_DIR, AGENTS_DIR));
        }

        String workspace = workspaceRootSupplier == null ? null : workspaceRootSupplier.get();
        if (workspace != null && !workspace.isBlank()) {
            roots.add(Paths.get(workspace, CLAUDE_DIR, AGENTS_DIR));
        }
        return roots;
    }

    /**
     * Report a change once the burst settles.
     *
     * <p>The flag is cleared before the callback runs, not after: a change that
     * lands while the callback is executing must schedule its own notification
     * rather than be folded into one that has already been delivered.
     */
    private void scheduleNotify() {
        if (!pending.compareAndSet(false, true)) {
            return;
        }
        AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
            pending.set(false);
            try {
                onChanged.run();
            } catch (Exception e) {
                LOG.warn("[AgentFileWatcher] Change notification failed: "
                        + e.getClass().getSimpleName());
            }
        }, DEBOUNCE_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * Subscribe to VFS changes.
     *
     * <p>The connection is tied to the project bus, so it is disposed with the
     * project and a closed project cannot leave a listener behind.
     */
    public void startWatching() {
        if (connection != null) {
            LOG.warn("[AgentFileWatcher] Already watching, skipping");
            return;
        }
        connection = project.getMessageBus().connect();
        connection.subscribe(VirtualFileManager.VFS_CHANGES, this);
        LOG.info("[AgentFileWatcher] Watching Claude agent files for changes");
    }

    /** Unsubscribe. Safe to call more than once. */
    public void stopWatching() {
        if (connection == null) {
            return;
        }
        try {
            connection.disconnect();
        } finally {
            connection = null;
        }
        LOG.info("[AgentFileWatcher] Stopped watching Claude agent files");
    }
}
