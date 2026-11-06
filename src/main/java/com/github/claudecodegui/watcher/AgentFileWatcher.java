package com.github.claudecodegui.watcher;

import com.github.claudecodegui.agent.SubagentDiscoveryScanner;
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

    /** How long to keep collecting before reporting, in milliseconds. */
    private static final long DEBOUNCE_MS = 400;

    /** How long to cache the workspace root string to avoid I/O on every batch. */
    private static final long WORKSPACE_ROOT_CACHE_MS = 1000;

    private final Project project;
    private final Supplier<String> workspaceRootSupplier;

    /**
     * Called, off the VFS thread, once per debounce window in which something
     * inside a discovery root changed.
     */
    private final Runnable onChanged;

    /** Guards the debounce so a burst produces one notification, not one per event. */
    private final AtomicBoolean pending = new AtomicBoolean(false);

    /** Cached roots to avoid reading config.json on every batch. */
    private volatile List<Path> cachedRoots = null;
    private volatile String cachedWorkspaceRoot = null;
    private volatile long workspaceRootCacheTime = 0;

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
        List<Path> roots = getRootsWithCache();
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
     * <p>A file or directory under a discovery root, ending in {@code .md} for files.
     * A false positive costs one wasted rescan and nothing else — the rescan applies
     * the real containment checks — so the test stays cheap and this stays simple.
     * A false <em>negative</em> is the expensive direction, and is what the cases
     * below pin: the extension comparison is case-insensitive because discovery's own
     * filter is, and the root comparison uses case-folded paths so it works correctly
     * on case-insensitive filesystems (the default on macOS and Windows).
     *
     * <p>Takes a path rather than a {@link VirtualFile} so the rule is directly
     * testable without the platform fixtures.
     *
     * @param path       the VFS path of the changed file or directory
     * @param isDirectory whether that path is a directory
     * @param roots      the discovery roots, as of this event
     * @return true when the change is one discovery cares about
     */
    static boolean isAgentFilePath(String path, boolean isDirectory, List<Path> roots) {
        Path file = Paths.get(path);
        Path fileName = file.getFileName();
        if (fileName == null) {
            return false;
        }

        String fileNameStr = fileName.toString();

        if (isDirectory) {
            // Directory events: check if the directory is under an agents root
            // (could be the agents root itself or a subdirectory for recursive scan)
            Path parent = file;
            String parentKey = comparisonKey(parent);
            for (Path root : roots) {
                if (root == null) continue;
                String rootKey = comparisonKey(root);
                if (rootKey != null && (parentKey.equals(rootKey) || parentKey.startsWith(rootKey + "/"))) {
                    return true;
                }
            }
            return false;
        }

        // File events: must be a .md file under an agents root
        if (!fileNameStr.toLowerCase(Locale.ROOT).endsWith(MARKDOWN_EXTENSION)) {
            return false;
        }
        Path parent = file.getParent();
        if (parent == null) {
            return false;
        }
        String parentKey = comparisonKey(parent);
        for (Path root : roots) {
            if (root == null) continue;
            String rootKey = comparisonKey(root);
            if (rootKey != null && (parentKey.equals(rootKey) || parentKey.startsWith(rootKey + "/"))) {
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
     * Get roots with caching to avoid reading config.json on every batch.
     * Cache is invalidated when the workspace root changes or after a short TTL.
     */
    private List<Path> getRootsWithCache() {
        long now = System.currentTimeMillis();
        // If cache is fresh, return it without calling the supplier
        if (cachedRoots != null && cachedWorkspaceRoot != null
                && (now - workspaceRootCacheTime) < WORKSPACE_ROOT_CACHE_MS) {
            return cachedRoots;
        }

        String workspace = workspaceRootSupplier == null ? null : workspaceRootSupplier.get();
        // If workspace root unchanged, update cache time and return cached roots
        if (cachedRoots != null && workspace != null && workspace.equals(cachedWorkspaceRoot)) {
            workspaceRootCacheTime = now;
            return cachedRoots;
        }
        // Workspace root changed or first call - refresh cache
        cachedWorkspaceRoot = workspace;
        workspaceRootCacheTime = now;
        cachedRoots = currentRoots();
        return cachedRoots;
    }

    /**
     * The roots, resolved now.
     *
     * <p>Uses SubagentDiscoveryScanner to get all roots including walk-up discovery.
     */
    private List<Path> currentRoots() {
        List<Path> roots = new ArrayList<>();

        String home = NodeDetector.resolveHomeForFileOps();
        if (home != null && !home.isBlank()) {
            roots.add(Paths.get(home, CLAUDE_DIR, AGENTS_DIR));
        }

        String workspace = workspaceRootSupplier == null ? null : workspaceRootSupplier.get();
        if (workspace != null && !workspace.isBlank()) {
            // Add all local roots from walk-up discovery
            roots.addAll(SubagentDiscoveryScanner.allLocalRoots(workspace));
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