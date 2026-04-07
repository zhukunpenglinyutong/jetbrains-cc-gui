package com.github.claudecodegui.approval;

import com.github.claudecodegui.handler.diff.DiffResult;
import com.github.claudecodegui.handler.diff.InteractiveDiffManager;
import com.github.claudecodegui.handler.diff.InteractiveDiffRequest;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.util.ContentRebuildUtil;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.ScrollType;
import com.intellij.openapi.editor.event.DocumentEvent;
import com.intellij.openapi.editor.event.DocumentListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.FileEditorManagerEvent;
import com.intellij.openapi.fileEditor.FileEditorManagerListener;
import com.intellij.openapi.fileEditor.TextEditor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.EditorNotifications;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Tracks post-edit file changes reported by the webview StatusPanel and exposes
 * them as inline approval targets inside source editors.
 */
@Service(Service.Level.PROJECT)
public final class PendingFileChangeApprovalService implements Disposable {

    private static final Logger LOG = Logger.getInstance(PendingFileChangeApprovalService.class);
    private static final long CONFLICT_SUPPRESSION_MS = 3000L;

    private final Project project;
    private final Map<String, PendingFileChange> pendingChanges = new LinkedHashMap<>();
    /** Stores the last synced current-content for each file, surviving accept/reject.
     *  Used as a fallback baseline when cumulative operations cancel out (revert scenario). */
    private final Map<String, String> lastKnownCurrentContent = new LinkedHashMap<>();
    private final InlineFileChangeDecorator inlineDecorator;
    private final AtomicInteger internalDocumentChangeDepth = new AtomicInteger();
    private volatile BrowserCallbacks browserCallbacks;
    private volatile String lastSyncedSnapshotSignature = "";
    private volatile boolean syncInProgress = false;
    private volatile boolean resolutionInProgress = false;

    public PendingFileChangeApprovalService(@NotNull Project project) {
        this.project = project;
        this.inlineDecorator = new InlineFileChangeDecorator(project, this);

        MessageBusConnection connection = project.getMessageBus().connect(this);
        connection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, new FileEditorManagerListener() {
            @Override
            public void fileOpened(@NotNull FileEditorManager source, @NotNull VirtualFile file) {
                inlineDecorator.refreshFile(file.getPath());
                // Also refresh the banner — fileOpened fires for newly opened files only.
                EditorNotifications.getInstance(project).updateNotifications(file);
            }

            @Override
            public void selectionChanged(@NotNull FileEditorManagerEvent event) {
                // When the user switches tabs, the notification system does NOT
                // automatically re-query collectNotificationData for the new file.
                // Without this, banners on files that were not selected during
                // refreshUiState will be permanently missing.
                VirtualFile newFile = event.getNewFile();
                if (newFile != null) {
                    EditorNotifications.getInstance(project).updateNotifications(newFile);
                }
            }
        });

        EditorFactory.getInstance().getEventMulticaster().addDocumentListener(new DocumentListener() {
            @Override
            public void documentChanged(@NotNull DocumentEvent event) {
                if (internalDocumentChangeDepth.get() > 0) {
                    return;
                }
                VirtualFile file = FileDocumentManager.getInstance().getFile(event.getDocument());
                if (file == null) {
                    return;
                }
                markConflicted(file.getPath());
            }
        }, this);

        EdtWatchdog.start(this);
    }

    public static PendingFileChangeApprovalService getInstance(@NotNull Project project) {
        return project.getService(PendingFileChangeApprovalService.class);
    }

    public void syncFromFrontend(
            @NotNull List<PendingFileChangePayload> payloads,
            @NotNull BrowserCallbacks callbacks
    ) {
        // Guard: if a hunk resolution is in progress, the JCEF callback from
        // sendDiffResult may trigger a React re-render that re-syncs.  Defer
        // to avoid VFS contention with openFile() on EDT.
        if (resolutionInProgress) {
            LOG.info("[syncFromFrontend] Deferred (resolutionInProgress=true)");
            ApplicationManager.getApplication().invokeLater(() -> syncFromFrontend(payloads, callbacks));
            return;
        }
        syncInProgress = true;
        try {
            syncFromFrontendInternal(payloads, callbacks);
        } finally {
            syncInProgress = false;
        }
    }

    private void syncFromFrontendInternal(
            @NotNull List<PendingFileChangePayload> payloads,
            @NotNull BrowserCallbacks callbacks
    ) {
        // ---- Phase 1: snapshot existing state under lock (fast) ----
        Map<String, PendingFileChange> existingSnapshot;
        Set<String> previousPaths;
        synchronized (this) {
            browserCallbacks = callbacks;
            existingSnapshot = new LinkedHashMap<>(pendingChanges);
            previousPaths = new LinkedHashSet<>(pendingChanges.keySet());
        }
        LOG.info("[syncFromFrontend] Received " + payloads.size() + " payload(s), existing pending: " + existingSnapshot.size());

        // ---- Phase 2: VFS refresh WITHOUT lock (slow disk I/O) ----
        // AI edits happen on disk (via Node bridge) — the in-memory Document
        // won't see them until VFS picks up the change.  This is the ONE place
        // where synchronous VFS refresh is required; reject/approve/navigate
        // paths modify through the Document API and don't need it.
        for (PendingFileChangePayload payload : payloads) {
            if (payload != null && payload.filePath != null && !payload.filePath.isBlank()) {
                String normalized = normalizePath(payload.filePath);
                VirtualFile vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(normalized.replace('\\', '/'));
                if (vf != null) {
                    vf.refresh(false, false);
                }
            }
        }

        // ---- Phase 3: build changes WITHOUT lock (file reads, hunk computation) ----
        LinkedHashMap<String, PendingFileChange> next = new LinkedHashMap<>();

        for (PendingFileChangePayload payload : payloads) {
            if (payload == null || payload.filePath == null || payload.filePath.isBlank()) {
                continue;
            }

            String normalizedPath = normalizePath(payload.filePath);
            PendingFileChange existing = existingSnapshot.get(normalizedPath);

            // If a non-detached pending change already exists, reuse its baseline
            // instead of trying to rebuild from accumulated operations (which fails
            // when operations reference intermediate content that no longer exists).
            if (existing != null && !existing.isDetachedFromFrontend()) {
                LOG.info("[syncFromFrontend] Refreshing existing non-detached change for: " + normalizedPath);
                PendingFileChange refreshed = refreshExistingChange(existing, payload);
                if (refreshed != null) {
                    LOG.info("[syncFromFrontend] Refreshed change has " + refreshed.pendingHunks.size() + " hunk(s) for: " + normalizedPath);
                    next.put(normalizedPath, refreshed);
                    continue;
                }
                // refreshExistingChange returned null — do NOT silently drop the file.
                // Fall through to buildPendingFileChange as a last resort.
                LOG.info("[syncFromFrontend] Refresh returned null, falling through to buildPendingFileChange for: " + normalizedPath);
            }

            PendingFileChange built = buildPendingFileChange(payload);
            if (existing != null && existing.isDetachedFromFrontend()) {
                if (built == null || existing.hasSameFrontendPayload(built)) {
                    LOG.info("[syncFromFrontend] Keeping detached existing for: " + normalizedPath);
                    next.put(normalizedPath, existing);
                    continue;
                }
            }
            if (built != null && built.hasPendingHunks()) {
                LOG.info("[syncFromFrontend] Built new change with " + built.pendingHunks.size() + " hunk(s) for: " + normalizedPath);
                next.put(normalizedPath, built);
            } else if (existing != null && !existing.isDetachedFromFrontend() && existing.hasPendingHunks()) {
                // Safety net: both refreshExistingChange and buildPendingFileChange
                // failed (common in revert scenarios where cumulative ops cancel out).
                // Preserve the existing review rather than silently dropping the file.
                LOG.info("[syncFromFrontend] Keeping existing change as safety net for: " + normalizedPath
                        + " (existing hunks=" + existing.getPendingHunkCount() + ")");
                next.put(normalizedPath, existing);
            } else {
                LOG.info("[syncFromFrontend] Build returned null or no hunks for: " + normalizedPath + " (built=" + (built != null) + ")");
            }
        }

        for (PendingFileChange existing : existingSnapshot.values()) {
            if (existing.isDetachedFromFrontend() && !next.containsKey(existing.filePath)) {
                next.put(existing.filePath, existing);
            }
        }

        // ---- Phase 4: commit results under lock (fast) ----
        boolean changed;
        boolean wasEmpty;
        String firstFilePath = null;
        synchronized (this) {
            String nextSignature = buildSnapshotSignature(next);
            if (nextSignature.equals(lastSyncedSnapshotSignature)) {
                LOG.info("[syncFromFrontend] Snapshot unchanged, skipping UI update");
                return;
            }

            wasEmpty = pendingChanges.isEmpty();
            pendingChanges.clear();
            pendingChanges.putAll(next);
            lastSyncedSnapshotSignature = nextSignature;

            // Persist lastSyncedCurrentContent for each file so we can use it as
            // a fallback baseline even after the PendingFileChange is accepted/rejected.
            for (PendingFileChange pfc : next.values()) {
                if (pfc.lastSyncedCurrentContent != null) {
                    lastKnownCurrentContent.put(pfc.filePath, pfc.lastSyncedCurrentContent);
                }
            }

            changed = true;
            if (wasEmpty && !pendingChanges.isEmpty()) {
                firstFilePath = pendingChanges.values().iterator().next().filePath;
            }
        }

        // ---- Phase 5: UI update WITHOUT lock ----
        LOG.info("[syncFromFrontend] Pending changes updated: " + next.size() + " file(s), refreshing UI");
        refreshUiState();

        if (firstFilePath != null) {
            String path = firstFilePath;
            ApplicationManager.getApplication().invokeLater(() -> activateFileChange(path));
        }
    }

    public synchronized int getPendingCount() {
        return pendingChanges.size();
    }

    public synchronized int getRemainingCount(@Nullable String currentFilePath) {
        int count = pendingChanges.size();
        if (currentFilePath != null && pendingChanges.containsKey(normalizePath(currentFilePath))) {
            return Math.max(0, count - 1);
        }
        return count;
    }

    @Nullable
    public synchronized PendingFileChange getPendingForFile(@NotNull String filePath) {
        return pendingChanges.get(normalizePath(filePath));
    }

    @NotNull
    synchronized Map<String, PendingFileChange> getPendingChangesSnapshot() {
        return new LinkedHashMap<>(pendingChanges);
    }

    @NotNull
    List<Editor> findEditorsForFile(@NotNull String filePath) {
        VirtualFile file = LocalFileSystem.getInstance().findFileByPath(filePath.replace('\\', '/'));
        if (file == null || !file.isValid()) {
            return List.of();
        }

        Document document = FileDocumentManager.getInstance().getDocument(file);
        if (document == null) {
            return List.of();
        }

        Editor[] editors = EditorFactory.getInstance().getEditors(document, project);
        List<Editor> result = new ArrayList<>(editors.length);
        for (Editor editor : editors) {
            if (!editor.isDisposed()) {
                result.add(editor);
            }
        }
        return result;
    }

    @Nullable
    public synchronized String getNextPendingFileName(@Nullable String currentFilePath) {
        String nextPath = getNextPendingPathLocked(currentFilePath);
        PendingFileChange next = nextPath != null ? pendingChanges.get(nextPath) : null;
        return next != null ? next.fileName : null;
    }

    public void activateFileChange(@NotNull String filePath) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null || project.isDisposed()) {
            return;
        }

        if (change.isConflicted()) {
            openFullDiff(change.filePath);
            return;
        }

        InlineDiffHunk firstHunk = change.getPendingHunks().isEmpty() ? null : change.getPendingHunks().get(0);
        if (firstHunk == null) {
            return;
        }
        openEditorAtHunk(change.filePath, firstHunk);
    }

    public void activateNextPendingFile(@Nullable String currentFilePath) {
        String nextPath;
        synchronized (this) {
            nextPath = getNextPendingPathLocked(currentFilePath);
        }
        if (nextPath != null) {
            activateFileChange(nextPath);
        }
    }

    public void activatePrevPendingFile(@Nullable String currentFilePath) {
        String prevPath;
        synchronized (this) {
            prevPath = getPrevPendingPathLocked(currentFilePath);
        }
        if (prevPath != null) {
            activateFileChange(prevPath);
        }
    }

    /** Returns the 1-based index of this file among all pending files, or 1 if not found. */
    public synchronized int getFileIndex(@Nullable String filePath) {
        if (filePath == null || pendingChanges.isEmpty()) {
            return 1;
        }
        String normalized = normalizePath(filePath);
        int index = 1;
        for (String key : pendingChanges.keySet()) {
            if (key.equals(normalized)) {
                return index;
            }
            index++;
        }
        return 1;
    }

    /**
     * Navigate to next hunk, circular within the current file only.
     * Used by both inline bar and banner ∧/∨ buttons.
     */
    public void activateNextHunk(@NotNull String filePath, @Nullable String currentHunkId) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null || change.isConflicted()) {
            return;
        }

        List<InlineDiffHunk> hunks = change.getPendingHunks();
        if (hunks.isEmpty()) {
            return;
        }

        if (currentHunkId == null) {
            openEditorAtHunk(filePath, hunks.get(0));
            return;
        }

        int index = findHunkIndex(hunks, currentHunkId);
        if (index < 0) {
            return;
        }
        // Circular within file: wrap to first hunk
        int nextIndex = (index + 1) % hunks.size();
        openEditorAtHunk(filePath, hunks.get(nextIndex));
    }

    /**
     * Navigate to previous hunk, circular within the current file only.
     * Used by both inline bar and banner ∧/∨ buttons.
     */
    public void activatePrevHunk(@NotNull String filePath, @Nullable String currentHunkId) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null || change.isConflicted()) {
            return;
        }

        List<InlineDiffHunk> hunks = change.getPendingHunks();
        if (hunks.isEmpty()) {
            return;
        }

        if (currentHunkId == null) {
            openEditorAtHunk(filePath, hunks.get(hunks.size() - 1));
            return;
        }

        int index = findHunkIndex(hunks, currentHunkId);
        if (index < 0) {
            return;
        }
        // Circular within file: wrap to last hunk
        int prevIndex = (index - 1 + hunks.size()) % hunks.size();
        openEditorAtHunk(filePath, hunks.get(prevIndex));
    }

    /**
     * Find the hunk ID nearest to the current caret position in the editor for the given file.
     * Used by banner navigation to determine the "current" hunk when no hunk ID is tracked.
     */
    @Nullable
    public String findCurrentHunkId(@NotNull String filePath) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null || change.isConflicted()) {
            return null;
        }
        List<InlineDiffHunk> hunks = change.getPendingHunks();
        if (hunks.isEmpty()) {
            return null;
        }
        List<Editor> editors = findEditorsForFile(filePath);
        if (editors.isEmpty()) {
            return hunks.get(0).getHunkId();
        }
        int caretLine = editors.get(0).getCaretModel().getLogicalPosition().line;

        InlineDiffHunk nearest = null;
        int nearestDist = Integer.MAX_VALUE;
        for (InlineDiffHunk hunk : hunks) {
            if (caretLine >= hunk.getAfterStartLine() && caretLine < hunk.getAfterEndLineExclusive()) {
                return hunk.getHunkId();
            }
            int dist;
            if (caretLine < hunk.getAfterStartLine()) {
                dist = hunk.getAfterStartLine() - caretLine;
            } else {
                dist = caretLine - hunk.getAfterEndLineExclusive() + 1;
            }
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = hunk;
            }
        }
        return nearest != null ? nearest.getHunkId() : null;
    }

    /**
     * Scrolls the editor to center the given hunk without changing review state.
     * Used when the user clicks the position indicator ("X of N") in the action bar.
     */
    public void scrollToHunk(@NotNull String filePath, @NotNull String hunkId) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null) {
            return;
        }
        for (InlineDiffHunk hunk : change.getPendingHunks()) {
            if (hunk.getHunkId().equals(hunkId)) {
                openEditorAtHunk(filePath, hunk);
                return;
            }
        }
    }

    private static int findHunkIndex(@NotNull List<InlineDiffHunk> hunks, @NotNull String hunkId) {
        for (int i = 0; i < hunks.size(); i++) {
            if (hunks.get(i).getHunkId().equals(hunkId)) {
                return i;
            }
        }
        return -1;
    }

    public boolean approveHunk(@NotNull String filePath, @NotNull String hunkId) {
        LOG.info("[approveHunk] START file=" + filePath + " hunkId=" + hunkId);
        resolutionInProgress = true;
        boolean result = approveHunkInternal(filePath, hunkId);
        if (!result) {
            // approveHunkInternal returned early without calling updatePendingHunks,
            // so resolutionInProgress won't be cleared there — clear it now.
            resolutionInProgress = false;
        }
        return result;
    }

    private boolean approveHunkInternal(@NotNull String filePath, @NotNull String hunkId) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null || change.isConflicted()) {
            LOG.info("[approveHunk] Skipped (change null or conflicted)");
            return false;
        }

        InlineDiffHunk hunk = change.findHunk(hunkId);
        if (hunk == null) {
            LOG.info("[approveHunk] Skipped (hunk not found)");
            return false;
        }

        HunkNavigationTarget navigationTarget = buildNavigationTarget(change, hunkId);
        detachFromFrontend(change);
        String currentContent = readCurrentFileContent(change.filePath);
        if (currentContent == null) {
            LOG.info("[approveHunk] Skipped (currentContent null)");
            return false;
        }

        synchronized (this) {
            PendingFileChange current = pendingChanges.get(change.filePath);
            if (current == null) {
                return false;
            }
            current.baselineContent = InlineDiffUtil.applyToBaseline(current.baselineContent, hunk);
        }

        LOG.info("[approveHunk] Calling updatePendingHunks for: " + filePath);
        boolean result = updatePendingHunks(change.filePath, currentContent, "APPLY", navigationTarget);
        LOG.info("[approveHunk] DONE file=" + filePath + " result=" + result);
        return result;
    }

    public boolean rejectHunk(@NotNull String filePath, @NotNull String hunkId) {
        LOG.info("[rejectHunk] START file=" + filePath + " hunkId=" + hunkId);
        resolutionInProgress = true;
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null || change.isConflicted()) {
            LOG.info("[rejectHunk] Skipped (change null or conflicted)");
            resolutionInProgress = false;
            return false;
        }

        InlineDiffHunk hunk = change.findHunk(hunkId);
        if (hunk == null) {
            LOG.info("[rejectHunk] Skipped (hunk not found)");
            resolutionInProgress = false;
            return false;
        }

        HunkNavigationTarget navigationTarget = buildNavigationTarget(change, hunkId);
        detachFromFrontend(change);
        String currentContent = readCurrentFileContent(change.filePath);
        if (currentContent == null) {
            LOG.info("[rejectHunk] Skipped (currentContent null)");
            resolutionInProgress = false;
            return false;
        }

        String revertedContent = InlineDiffUtil.revertFromCurrent(currentContent, hunk);
        LOG.info("[rejectHunk] Writing reverted content for: " + filePath);
        try {
            writeCurrentContent(change, revertedContent);
        } catch (Exception e) {
            LOG.error("Failed to reject inline hunk for " + change.filePath, e);
            resolutionInProgress = false;
            return false;
        }
        LOG.info("[rejectHunk] Write complete, calling updatePendingHunks");

        boolean result = updatePendingHunks(change.filePath, revertedContent, "REJECT", navigationTarget);
        LOG.info("[rejectHunk] DONE file=" + filePath + " result=" + result);
        return result;
    }

    public boolean approveFileChange(@NotNull String filePath) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null) {
            return false;
        }

        detachFromFrontend(change);
        String currentContent = readCurrentFileContent(change.filePath);
        if (currentContent == null) {
            return false;
        }

        synchronized (this) {
            PendingFileChange current = pendingChanges.remove(change.filePath);
            if (current == null) {
                return false;
            }
            current.baselineContent = currentContent;
            updateSnapshotSignatureLocked();
        }
        notifyResolved(change.filePath, "APPLY");
        refreshUiState();
        return true;
    }

    public boolean rejectFileChange(@NotNull String filePath) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null) {
            return false;
        }

        detachFromFrontend(change);
        try {
            writeCurrentContent(change, change.baselineContent);
        } catch (Exception e) {
            LOG.error("Failed to reject file change for " + change.filePath, e);
            return false;
        }

        synchronized (this) {
            if (pendingChanges.remove(change.filePath) == null) {
                return false;
            }
            updateSnapshotSignatureLocked();
        }
        notifyResolved(change.filePath, "REJECT");
        refreshUiState();
        return true;
    }

    public void openFullDiff(@NotNull String filePath) {
        PendingFileChange change = getPendingForFile(filePath);
        if (change == null) {
            return;
        }

        detachFromFrontend(change);
        String currentContent = readCurrentFileContent(change.filePath);
        if (currentContent == null) {
            return;
        }

        String tabName = ClaudeCodeGuiBundle.message("diff.reviewTabName", change.fileName);
        InteractiveDiffRequest request = change.status == FileStatus.ADDED
                ? InteractiveDiffRequest.forNewFile(change.filePath, currentContent, tabName)
                : InteractiveDiffRequest.forModifiedFile(change.filePath, change.baselineContent, currentContent, tabName);

        InteractiveDiffManager.showInteractiveDiff(project, request)
                .thenAccept(result -> handleFullDiffResult(change.filePath, result))
                .exceptionally(error -> {
                    LOG.error("Failed to open fallback diff for " + change.filePath, error);
                    return null;
                });
    }

    @Override
    public synchronized void dispose() {
        EdtWatchdog.stop();
        pendingChanges.clear();
        lastKnownCurrentContent.clear();
        browserCallbacks = null;
        lastSyncedSnapshotSignature = "";
        inlineDecorator.dispose();
        refreshUiState();
    }

    private void handleFullDiffResult(@NotNull String filePath, @NotNull DiffResult result) {
        if (result.isDismissed()) {
            return;
        }
        if (result.isApplied()) {
            approveFileChange(filePath);
            return;
        }
        if (result.isRejected()) {
            rejectFileChange(filePath);
        }
    }

    private boolean updatePendingHunks(
            @NotNull String filePath,
            @NotNull String currentContent,
            @NotNull String resolvedAction,
            @Nullable HunkNavigationTarget navigationTarget
    ) {
        LOG.info("[updatePendingHunks] START file=" + filePath + " action=" + resolvedAction);
        // Read baseline outside the synchronized block so we can compute the
        // diff without holding the monitor (computeHunks can be expensive).
        String baseline;
        synchronized (this) {
            PendingFileChange current = pendingChanges.get(filePath);
            if (current == null) {
                LOG.info("[updatePendingHunks] Skipped (change not found in first lock)");
                return false;
            }
            baseline = current.baselineContent;
        }

        LOG.info("[updatePendingHunks] Computing hunks (baselineLen=" + baseline.length() + " currentLen=" + currentContent.length() + ")");
        List<InlineDiffHunk> newHunks = InlineDiffUtil.computeHunks(baseline, currentContent);
        LOG.info("[updatePendingHunks] Computed " + newHunks.size() + " remaining hunk(s)");

        PendingFileChange removed;
        synchronized (this) {
            PendingFileChange current = pendingChanges.get(filePath);
            if (current == null) {
                return false;
            }

            current.pendingHunks = new ArrayList<>(newHunks);
            current.conflicted = false;
            if (current.pendingHunks.isEmpty()) {
                removed = pendingChanges.remove(filePath);
                LOG.info("[updatePendingHunks] All hunks resolved, file removed from pending");
            } else {
                removed = null;
            }
            updateSnapshotSignatureLocked();
        }

        // Clear the resolution guard BEFORE notifyResolved so that any
        // frontend resync triggered by sendDiffResult/sendRemoveFileFromEdits
        // is allowed to proceed.  pendingHunks has already been updated above.
        resolutionInProgress = false;

        if (removed != null) {
            notifyResolved(removed.filePath, resolvedAction);
        }

        // Chain: refresh UI → clean decorations → THEN navigate.
        // Previously these were sibling invokeLater calls, allowing navigation
        // to open a new file BEFORE decorations were cleaned up.
        final String resolvedFilePath = filePath;
        if (navigationTarget != null) {
            LOG.info("[updatePendingHunks] Chaining refreshUiState → navigation via callback");
            refreshUiStateWithCallback(resolvedFilePath,
                    () -> navigateAfterHunkResolution(navigationTarget));
        } else {
            LOG.info("[updatePendingHunks] Calling refreshUiState (no navigation)");
            refreshUiState(resolvedFilePath);
        }
        LOG.info("[updatePendingHunks] DONE");
        return true;
    }

    @Nullable
    private HunkNavigationTarget buildNavigationTarget(
            @NotNull PendingFileChange change,
            @NotNull String hunkId
    ) {
        List<InlineDiffHunk> hunks = change.getPendingHunks();
        int currentIndex = -1;
        for (int i = 0; i < hunks.size(); i++) {
            if (hunks.get(i).getHunkId().equals(hunkId)) {
                currentIndex = i;
                break;
            }
        }
        if (currentIndex < 0) {
            return null;
        }

        String nextFilePath;
        synchronized (this) {
            nextFilePath = getNextPendingPathLocked(change.filePath);
        }
        return new HunkNavigationTarget(change.filePath, currentIndex, nextFilePath);
    }

    private void navigateAfterHunkResolution(@NotNull HunkNavigationTarget navigationTarget) {
        long t0 = System.nanoTime();
        LOG.info("[EDT-DIAG] navigateAfterHunkResolution START file=" + navigationTarget.filePath
                + " nextHunkIndex=" + navigationTarget.nextHunkIndex
                + " nextFilePath=" + navigationTarget.nextFilePath);
        PendingFileChange currentFileChange = getPendingForFile(navigationTarget.filePath);
        if (currentFileChange != null && !currentFileChange.isConflicted()) {
            List<InlineDiffHunk> hunks = currentFileChange.getPendingHunks();
            if (navigationTarget.nextHunkIndex < hunks.size()) {
                LOG.info("[EDT-DIAG] navigateAfterHunkResolution → same file hunk, elapsed=" + (System.nanoTime() - t0) / 1_000_000 + "ms");
                openEditorAtHunk(currentFileChange.filePath, hunks.get(navigationTarget.nextHunkIndex));
                return;
            }
        }

        // Current file fully resolved — do NOT auto-navigate to next file.
        // The banner will show "Review Next File" if other files have pending changes.
        LOG.info("[EDT-DIAG] navigateAfterHunkResolution → file resolved, staying in current editor, elapsed=" + (System.nanoTime() - t0) / 1_000_000 + "ms");
    }

    private void notifyResolved(@NotNull String filePath, @NotNull String action) {
        BrowserCallbacks callbacks = browserCallbacks;
        if (callbacks != null) {
            callbacks.sendDiffResult(filePath, action, null, null);
        }
    }

    private void detachFromFrontend(@NotNull PendingFileChange change) {
        boolean shouldNotify = false;
        synchronized (this) {
            PendingFileChange current = pendingChanges.get(change.filePath);
            if (current != null && !current.detachedFromFrontend) {
                current.detachedFromFrontend = true;
                shouldNotify = true;
                updateSnapshotSignatureLocked();
            }
        }

        if (shouldNotify) {
            BrowserCallbacks callbacks = browserCallbacks;
            if (callbacks != null) {
                callbacks.sendRemoveFileFromEdits(change.filePath);
            }
        }
    }

    private void markConflicted(@NotNull String filePath) {
        if (syncInProgress) {
            LOG.info("[markConflicted] Skipped (syncInProgress=true) for: " + filePath);
            return;
        }
        boolean changed = false;
        synchronized (this) {
            PendingFileChange pending = pendingChanges.get(normalizePath(filePath));
            if (pending != null && !pending.conflicted) {
                long now = System.currentTimeMillis();
                if (now < pending.conflictSuppressedUntilMs) {
                    LOG.info("[markConflicted] Suppressed (window active, " + (pending.conflictSuppressedUntilMs - now) + "ms remaining) for: " + filePath);
                    return;
                }
                pending.conflicted = true;
                changed = true;
                updateSnapshotSignatureLocked();
                LOG.info("[markConflicted] Marked conflicted: " + filePath);
            }
        }
        if (changed) {
            refreshUiState();
        }
    }

    private void openEditorAtHunk(@NotNull String filePath, @NotNull InlineDiffHunk hunk) {
        VirtualFile file = LocalFileSystem.getInstance().findFileByPath(filePath.replace('\\', '/'));
        if (file == null || !file.isValid()) {
            return;
        }

        // CRITICAL: After writeCurrentContent() modifies a document, the
        // StickyLinesPanel still holds stale cached offsets.  Any call to
        // openTextEditor() / openFile() triggers runWithModalProgressBlocking
        // → layout validation → StickyLinesPanel.repaintLines() which uses
        // the stale offset → IndexOutOfBoundsException → modal never
        // completes → EDT frozen.
        //
        // Fix: defer ALL editor opening and navigation to invokeLater so
        // that one extra EDT event cycle runs first, giving StickyLines a
        // chance to invalidate its cache after the document change.
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }

            long diagStart = System.nanoTime();
            LOG.info("[EDT-DIAG] openEditorAtHunk invokeLater START for: " + filePath);
            Editor editor = null;
            boolean newlyOpened = false;
            List<Editor> existingEditors = findEditorsForFile(filePath);
            if (!existingEditors.isEmpty()) {
                editor = existingEditors.get(0);
                long t1 = System.nanoTime();
                // CRITICAL: Use requestFocus=false to avoid
                // FocusManagerImpl.toFront() → WWindowPeer._toFront(Native)
                // which can block EDT for 30+ seconds on Windows when the
                // sandbox IDE doesn't have foreground rights.
                // We manually focus the editor component below instead.
                FileEditorManager.getInstance(project).openFile(file, false);
                LOG.info("[EDT-DIAG] openFile(existing) took " + (System.nanoTime() - t1) / 1_000_000 + "ms");
            } else {
                newlyOpened = true;
                try {
                    long t2 = System.nanoTime();
                    LOG.info("[EDT-DIAG] openFile(NEW) starting for: " + filePath);
                    // Same: requestFocus=false to avoid toFront native hang.
                    FileEditor[] fileEditors = FileEditorManager.getInstance(project).openFile(file, false);
                    LOG.info("[EDT-DIAG] openFile(NEW) took " + (System.nanoTime() - t2) / 1_000_000 + "ms");
                    for (FileEditor fe : fileEditors) {
                        if (fe instanceof TextEditor) {
                            editor = ((TextEditor) fe).getEditor();
                            break;
                        }
                    }
                } catch (Exception e) {
                    LOG.warn("[EDT-DIAG] openFile FAILED (non-fatal): " + filePath, e);
                    return;
                }
            }

            // Manually focus editor component within the IDE window.
            // This does NOT call Window.toFront() and avoids the native hang.
            if (editor != null && !editor.isDisposed()) {
                editor.getContentComponent().requestFocusInWindow();
            }

            if (editor == null || editor.isDisposed()) {
                LOG.info("[openEditorAtHunk] Editor null or disposed, aborting scroll");
                return;
            }

            if (newlyOpened) {
                // CRITICAL: For newly opened editors, defer the scroll to a
                // separate invokeLater so the editor has one full EDT cycle to
                // complete its layout initialization.  Calling scrollToCaret
                // immediately after openTextEditor can trigger StickyLinesPanel
                // to access uninitialized line offsets → IOOBE → the modal
                // progress from openTextEditor never completes → EDT frozen.
                Editor editorToScroll = editor;
                LOG.info("[openEditorAtHunk] Deferring scroll for newly opened editor");
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (!editorToScroll.isDisposed()) {
                        scrollEditorToHunk(editorToScroll, hunk);
                    }
                    LOG.info("[openEditorAtHunk] Deferred scroll DONE");
                });
            } else {
                LOG.info("[openEditorAtHunk] Scrolling to hunk (existing editor)");
                scrollEditorToHunk(editor, hunk);
                LOG.info("[openEditorAtHunk] DONE");
            }
        });
    }

    private void scrollEditorToHunk(@NotNull Editor editor, @NotNull InlineDiffHunk hunk) {
        if (editor.isDisposed()) {
            return;
        }
        try {
            Document document = editor.getDocument();
            if (document.getLineCount() == 0) {
                return;
            }
            int targetLine = Math.max(0, Math.min(
                    hunk.hasAfterLines() ? hunk.getAfterStartLine() : hunk.getAfterStartLine(),
                    document.getLineCount() - 1
            ));
            int offset = document.getLineStartOffset(targetLine);
            editor.getCaretModel().moveToOffset(offset);
            editor.getScrollingModel().scrollToCaret(ScrollType.CENTER);
        } catch (Exception e) {
            // Safety net: scroll failures must never freeze the EDT.
            // StickyLinesPanel or other editor components may throw IOOBE
            // if the editor layout is not fully initialized.
            LOG.warn("[scrollEditorToHunk] Scroll failed (non-fatal): " + e.getMessage(), e);
        }
    }

    @Nullable
    private PendingFileChange buildPendingFileChange(@NotNull PendingFileChangePayload payload) {
        List<EditOperation> sanitizedOperations = sanitizeOperations(payload.operations);
        if (sanitizedOperations.isEmpty()) {
            LOG.info("[buildPendingFileChange] No sanitized operations for: " + payload.filePath);
            return null;
        }

        String normalizedPath = normalizePath(payload.filePath);
        String currentContent = readCurrentFileContent(normalizedPath);
        FileStatus status = FileStatus.fromRaw(payload.status);
        if (currentContent == null) {
            if (status == FileStatus.ADDED) {
                currentContent = "";
            } else {
                LOG.warn("[buildPendingFileChange] File missing: " + normalizedPath);
                return null;
            }
        }

        // Log individual operation details to help diagnose missing hunks
        for (int i = 0; i < sanitizedOperations.size(); i++) {
            EditOperation op = sanitizedOperations.get(i);
            LOG.info("[buildPendingFileChange] op[" + i + "]"
                    + " replaceAll=" + op.replaceAll
                    + " oldLen=" + op.oldString.length()
                    + " newLen=" + op.newString.length()
                    + " oldLines=" + op.oldString.split("\n", -1).length
                    + " newLines=" + op.newString.split("\n", -1).length
                    + " oldSnippet=" + snippet(op.oldString)
                    + " newSnippet=" + snippet(op.newString));
        }

        String baselineContent = status == FileStatus.ADDED
                ? ""
                : ContentRebuildUtil.rebuildBeforeContent(currentContent, toJsonEdits(sanitizedOperations));
        List<InlineDiffHunk> hunks = InlineDiffUtil.computeHunks(baselineContent, currentContent);
        LOG.info("[buildPendingFileChange] file=" + normalizedPath
                + " ops=" + sanitizedOperations.size()
                + " baselineLen=" + baselineContent.length()
                + " currentLen=" + currentContent.length()
                + " hunks=" + hunks.size());
        for (InlineDiffHunk h : hunks) {
            LOG.info("[buildPendingFileChange]   hunk type=" + h.getType()
                    + " before=" + h.getBeforeStartLine() + "-" + h.getBeforeEndLineExclusive()
                    + " after=" + h.getAfterStartLine() + "-" + h.getAfterEndLineExclusive()
                    + " +" + h.getAddedLineCount() + "/-" + h.getDeletedLineCount());
        }

        // Fallback for revert scenarios: when cumulative operations cancel out
        // (A→B→A), rebuildBeforeContent produces baseline=A=current → 0 hunks.
        // Use the last known current-content (B) from a previous sync as baseline.
        if (hunks.isEmpty()) {
            String lastKnown = lastKnownCurrentContent.get(normalizedPath);
            if (lastKnown != null) {
                String normalizedLastKnown = InlineDiffUtil.normalize(lastKnown);
                String normalizedCurrent = InlineDiffUtil.normalize(currentContent);
                if (!normalizedLastKnown.equals(normalizedCurrent)) {
                    hunks = InlineDiffUtil.computeHunks(normalizedLastKnown, normalizedCurrent);
                    LOG.info("[buildPendingFileChange] lastKnownCurrentContent fallback produced "
                            + hunks.size() + " hunk(s) for: " + normalizedPath);
                    if (!hunks.isEmpty()) {
                        baselineContent = normalizedLastKnown;
                    }
                } else {
                    LOG.info("[buildPendingFileChange] lastKnownCurrentContent equals current for: " + normalizedPath);
                }
            }
        }

        if (hunks.isEmpty()) {
            return null;
        }

        return new PendingFileChange(
                normalizedPath,
                payload.fileName != null && !payload.fileName.isEmpty()
                        ? payload.fileName
                        : new File(normalizedPath).getName(),
                status,
                buildFrontendPayloadSignature(sanitizedOperations),
                baselineContent,
                hunks,
                currentContent
        );
    }

    @Nullable
    private PendingFileChange refreshExistingChange(
            @NotNull PendingFileChange existing,
            @NotNull PendingFileChangePayload payload
    ) {
        String currentContent = readCurrentFileContent(existing.filePath);
        if (currentContent == null) {
            LOG.info("[refreshExistingChange] currentContent is null for: " + existing.filePath);
            return null;
        }

        // Use the previous sync's current content as baseline, so the diff
        // shows what the latest AI operation changed — not the cumulative diff.
        // This way a revert (A→B→A) still shows the B→A change for review.
        String newBaseline = existing.lastSyncedCurrentContent != null
                ? existing.lastSyncedCurrentContent
                : existing.baselineContent;

        boolean sameContent = InlineDiffUtil.normalize(newBaseline).equals(InlineDiffUtil.normalize(currentContent));
        LOG.info("[refreshExistingChange] file=" + existing.filePath
                + " baselineLen=" + newBaseline.length()
                + " currentLen=" + currentContent.length()
                + " sameContent=" + sameContent
                + " usingLastSynced=" + (existing.lastSyncedCurrentContent != null));

        List<InlineDiffHunk> hunks = InlineDiffUtil.computeHunks(
                newBaseline, currentContent
        );
        LOG.info("[refreshExistingChange] Computed " + hunks.size() + " hunk(s) from disk read for: " + existing.filePath);

        // If hunks are empty, the disk read likely returned stale content
        // (VFS cache, OS file buffer timing, etc.).  Fall back to computing
        // the expected current content by applying ALL payload operations
        // forward from the original baseline.  This is purely computational
        // and does not depend on disk I/O timing.
        if (hunks.isEmpty() && !sameContent) {
            List<EditOperation> ops = sanitizeOperations(payload.operations);
            String expectedCurrent = applyOperationsForward(existing.baselineContent, ops);
            if (expectedCurrent != null) {
                hunks = InlineDiffUtil.computeHunks(newBaseline, expectedCurrent);
                LOG.info("[refreshExistingChange] Forward-apply fallback produced " + hunks.size()
                        + " hunk(s) for: " + existing.filePath);
                if (!hunks.isEmpty()) {
                    currentContent = expectedCurrent;
                }
            }
        }

        // FINAL FALLBACK — revert detection using stored content only.
        // In a revert scenario (A→B→A), if the disk read returned stale content B
        // and applyOperationsForward also failed (indexOf mismatches), both previous
        // strategies produce 0 hunks.  But we still have the original baseline (A)
        // and the lastSyncedCurrentContent (B) stored in memory.  If they differ,
        // and the new payload has MORE operations than the current signature (meaning
        // the frontend sent new work), assume a revert happened and show B→A hunks.
        if (hunks.isEmpty() && !sameContent && existing.lastSyncedCurrentContent != null) {
            String normalizedOriginal = InlineDiffUtil.normalize(existing.baselineContent);
            String normalizedLastSynced = InlineDiffUtil.normalize(existing.lastSyncedCurrentContent);
            if (!normalizedOriginal.equals(normalizedLastSynced)) {
                hunks = InlineDiffUtil.computeHunks(normalizedLastSynced, normalizedOriginal);
                LOG.info("[refreshExistingChange] Stored-content revert fallback produced "
                        + hunks.size() + " hunk(s) for: " + existing.filePath);
                if (!hunks.isEmpty()) {
                    currentContent = normalizedOriginal;
                }
            }
        }

        if (hunks.isEmpty()) {
            LOG.info("[refreshExistingChange] All strategies produced 0 hunks for: " + existing.filePath);
            return null;
        }

        List<EditOperation> ops = sanitizeOperations(payload.operations);
        return new PendingFileChange(
                existing.filePath,
                existing.fileName,
                existing.status,
                buildFrontendPayloadSignature(ops),
                newBaseline,
                hunks,
                currentContent
        );
    }

    /**
     * Simulate applying edit operations forward to a baseline content string.
     * This mirrors what the AI tool actually does when executing edits.
     * Used as a fallback when the disk read returns stale content.
     */
    @Nullable
    private static String applyOperationsForward(
            @NotNull String baselineContent,
            @NotNull List<EditOperation> operations
    ) {
        if (operations.isEmpty()) {
            return null;
        }
        String content = InlineDiffUtil.normalize(baselineContent);
        for (EditOperation op : operations) {
            String oldStr = InlineDiffUtil.normalize(op.oldString);
            String newStr = InlineDiffUtil.normalize(op.newString);
            if (oldStr.isEmpty()) {
                // Write / create_file tool: replace entire content
                content = newStr;
                continue;
            }
            if (op.replaceAll) {
                content = content.replace(oldStr, newStr);
            } else {
                int idx = content.indexOf(oldStr);
                if (idx >= 0) {
                    content = content.substring(0, idx) + newStr + content.substring(idx + oldStr.length());
                }
                // If oldStr is not found, the operation may have already been applied
                // or it targets content that doesn't exist — skip silently.
            }
        }
        return content;
    }

    @Nullable
    private String readCurrentFileContent(@NotNull String filePath) {
        // Prefer reading from the in-memory Document to avoid synchronous disk I/O on EDT.
        // Fall back to disk only when the document is not available (file not open in editor).
        // Must use runReadAction because syncFromFrontend is called from a JCEF callback
        // thread, and FileDocumentManager.getDocument() requires read-action context.
        VirtualFile vFile = LocalFileSystem.getInstance().findFileByPath(filePath.replace('\\', '/'));
        if (vFile != null && vFile.isValid()) {
            String[] result = {null};
            ApplicationManager.getApplication().runReadAction(() -> {
                Document document = FileDocumentManager.getInstance().getDocument(vFile);
                if (document != null) {
                    result[0] = document.getText();
                }
            });
            if (result[0] != null) {
                return result[0];
            }
        }

        // Fallback: read from disk (used when file is not open in an editor,
        // e.g. during initial sync from frontend).
        if (ApplicationManager.getApplication().isDispatchThread()) {
            LOG.warn("[EDT-DIAG] readCurrentFileContent falling back to DISK I/O on EDT for: " + filePath);
        }
        java.nio.file.Path diskPath = Paths.get(filePath.replace('\\', '/'));
        if (!java.nio.file.Files.exists(diskPath) || java.nio.file.Files.isDirectory(diskPath)) {
            return null;
        }
        try {
            Charset charset = StandardCharsets.UTF_8;
            if (vFile != null && vFile.getCharset() != null) {
                charset = vFile.getCharset();
            }
            byte[] bytes = java.nio.file.Files.readAllBytes(diskPath);
            return new String(bytes, charset);
        } catch (IOException e) {
            LOG.error("Failed to read from disk: " + filePath, e);
            return null;
        }
    }

    private void writeCurrentContent(@NotNull PendingFileChange change, @NotNull String content) throws Exception {
        VirtualFile file = LocalFileSystem.getInstance().findFileByPath(change.filePath.replace('\\', '/'));

        internalDocumentChangeDepth.incrementAndGet();
        try {
            if (file == null || !file.exists()) {
                if (change.status == FileStatus.ADDED && content.isEmpty()) {
                    return;
                }
                throw new Exception("File not found: " + change.filePath);
            }

            if (change.status == FileStatus.ADDED && content.isEmpty()) {
                deleteFile(file);
                return;
            }

            Document document = FileDocumentManager.getInstance().getDocument(file);
            if (document != null) {
                WriteCommandAction.runWriteCommandAction(project, "Apply Inline AI Changes", null, () -> {
                    // Use targeted replaceString instead of setText to avoid full-document
                    // reparse. Compute the minimal changed region (common prefix/suffix)
                    // and only replace that slice — IntelliJ only reparses the affected area.
                    CharSequence currentText = document.getCharsSequence();
                    int currentLen = currentText.length();
                    int newLen = content.length();
                    int commonPrefix = 0;
                    int limit = Math.min(currentLen, newLen);
                    while (commonPrefix < limit && currentText.charAt(commonPrefix) == content.charAt(commonPrefix)) {
                        commonPrefix++;
                    }
                    int commonSuffix = 0;
                    int suffixLimit = Math.min(currentLen - commonPrefix, newLen - commonPrefix);
                    while (commonSuffix < suffixLimit
                            && currentText.charAt(currentLen - 1 - commonSuffix) == content.charAt(newLen - 1 - commonSuffix)) {
                        commonSuffix++;
                    }
                    int replaceEnd = currentLen - commonSuffix;
                    String replacement = content.substring(commonPrefix, newLen - commonSuffix);
                    if (commonPrefix < replaceEnd || !replacement.isEmpty()) {
                        document.replaceString(commonPrefix, replaceEnd, replacement);
                    }
                });
            } else {
                Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;
                WriteCommandAction.runWriteCommandAction(project, "Apply Inline AI Changes", null, () -> {
                    try {
                        file.setBinaryContent(content.getBytes(charset));
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
            }
        } catch (RuntimeException runtimeException) {
            if (runtimeException.getCause() instanceof IOException ioException) {
                throw ioException;
            }
            throw runtimeException;
        } finally {
            internalDocumentChangeDepth.decrementAndGet();
        }
    }

    private void deleteFile(@NotNull VirtualFile file) throws Exception {
        final Exception[] errorHolder = new Exception[1];
        WriteCommandAction.runWriteCommandAction(project, "Reject AI Added File", null, () -> {
            try {
                file.delete(this);
            } catch (IOException e) {
                errorHolder[0] = e;
            }
        });
        if (errorHolder[0] != null) {
            throw errorHolder[0];
        }
    }

    private void refreshUiState() {
        refreshUiState(null);
    }

    private void refreshUiState(@Nullable String resolvedFilePath) {
        refreshUiStateWithCallback(resolvedFilePath, null);
    }

    /**
     * Refresh UI state with an optional callback that runs AFTER decoration
     * cleanup is complete.  Uses targeted {@code updateNotifications(VirtualFile)}
     * instead of the expensive {@code updateAllNotifications()}.
     */
    private void refreshUiStateWithCallback(
            @Nullable String resolvedFilePath,
            @Nullable Runnable afterRefresh
    ) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }

            long t0 = System.nanoTime();
            LOG.info("[EDT-DIAG] refreshUiState START (resolvedFile=" + resolvedFilePath + ")");

            // Targeted notification update — only the resolved file and current editor.
            // Previously this was updateAllNotifications() which iterates ALL editors
            // and ALL providers synchronously on EDT.
            long t1 = System.nanoTime();
            EditorNotifications notifications = EditorNotifications.getInstance(project);
            if (resolvedFilePath != null) {
                VirtualFile resolvedVf = LocalFileSystem.getInstance()
                        .findFileByPath(resolvedFilePath.replace('\\', '/'));
                if (resolvedVf != null && resolvedVf.isValid()) {
                    notifications.updateNotifications(resolvedVf);
                }
            }
            // Update the currently visible editor for "N other files pending" banner
            FileEditor selected = FileEditorManager.getInstance(project).getSelectedEditor();
            if (selected != null && selected.getFile() != null) {
                notifications.updateNotifications(selected.getFile());
            }
            long t2 = System.nanoTime();
            LOG.info("[EDT-DIAG] targeted updateNotifications took " + (t2 - t1) / 1_000_000 + "ms");

            ClaudeNotifier.setPendingReviews(project, getPendingCount());

            // Refresh decorations; navigation (if any) runs AFTER cleanup completes.
            inlineDecorator.refreshAllWithCallback(afterRefresh);

            long t3 = System.nanoTime();
            LOG.info("[EDT-DIAG] refreshUiState TOTAL " + (t3 - t0) / 1_000_000 + "ms");
        });
    }

    @Nullable
    private synchronized String getNextPendingPathLocked(@Nullable String currentFilePath) {
        if (pendingChanges.isEmpty()) {
            return null;
        }

        List<String> paths = new ArrayList<>(pendingChanges.keySet());
        if (currentFilePath == null) {
            return paths.get(0);
        }

        String normalized = normalizePath(currentFilePath);
        int index = paths.indexOf(normalized);
        if (index < 0) {
            return paths.get(0);
        }
        return paths.get((index + 1) % paths.size());
    }

    private synchronized String getPrevPendingPathLocked(@Nullable String currentFilePath) {
        if (pendingChanges.isEmpty()) {
            return null;
        }

        List<String> paths = new ArrayList<>(pendingChanges.keySet());
        if (currentFilePath == null) {
            return paths.get(paths.size() - 1);
        }

        String normalized = normalizePath(currentFilePath);
        int index = paths.indexOf(normalized);
        if (index < 0) {
            return paths.get(paths.size() - 1);
        }
        return paths.get((index - 1 + paths.size()) % paths.size());
    }

    @NotNull
    private JsonArray toJsonEdits(@NotNull List<EditOperation> operations) {
        JsonArray edits = new JsonArray();
        for (EditOperation op : operations) {
            JsonObject edit = new JsonObject();
            edit.addProperty("oldString", op.oldString);
            edit.addProperty("newString", op.newString);
            edit.addProperty("replaceAll", op.replaceAll);
            edits.add(edit);
        }
        return edits;
    }

    @NotNull
    private String buildSnapshotSignature(@NotNull Map<String, PendingFileChange> changes) {
        StringBuilder signature = new StringBuilder();
        for (PendingFileChange change : changes.values()) {
            signature.append(change.filePath)
                    .append('|')
                    .append(change.status.name())
                    .append('|')
                    .append(change.frontendPayloadSignature)
                    .append('|')
                    .append(change.detachedFromFrontend ? '1' : '0')
                    .append('|')
                    .append(change.conflicted ? '1' : '0')
                    .append('|')
                    .append(change.baselineContent.hashCode())
                    .append('|');
            for (InlineDiffHunk hunk : change.pendingHunks) {
                signature.append(hunk.getType().name())
                        .append(':')
                        .append(hunk.getBeforeStartLine())
                        .append('-')
                        .append(hunk.getBeforeEndLineExclusive())
                        .append(':')
                        .append(hunk.getAfterStartLine())
                        .append('-')
                        .append(hunk.getAfterEndLineExclusive())
                        .append(':')
                        .append(hunk.getBeforeText().hashCode())
                        .append(':')
                        .append(hunk.getAfterText().hashCode())
                        .append(',');
            }
            signature.append(';');
        }
        return signature.toString();
    }

    private synchronized void updateSnapshotSignatureLocked() {
        lastSyncedSnapshotSignature = buildSnapshotSignature(pendingChanges);
    }

    @NotNull
    private static String buildFrontendPayloadSignature(@NotNull List<EditOperation> operations) {
        StringBuilder signature = new StringBuilder();
        for (EditOperation operation : operations) {
            signature.append(operation.oldString.hashCode())
                    .append(':')
                    .append(operation.newString.hashCode())
                    .append(':')
                    .append(operation.replaceAll ? '1' : '0')
                    .append(';');
        }
        return signature.toString();
    }

    @NotNull
    private static List<EditOperation> sanitizeOperations(@Nullable List<EditOperation> operations) {
        if (operations == null || operations.isEmpty()) {
            return List.of();
        }

        List<EditOperation> sanitized = new ArrayList<>();
        for (EditOperation operation : operations) {
            if (operation == null) {
                continue;
            }
            String oldString = operation.oldString != null ? operation.oldString : "";
            String newString = operation.newString != null ? operation.newString : "";
            if (InlineDiffUtil.normalize(oldString).equals(InlineDiffUtil.normalize(newString))) {
                continue;
            }
            EditOperation copy = new EditOperation();
            copy.oldString = oldString;
            copy.newString = newString;
            copy.replaceAll = operation.replaceAll;
            sanitized.add(copy);
        }
        return sanitized;
    }

    @NotNull
    private static String snippet(@NotNull String s) {
        String flat = s.replace('\n', '\u23CE').replace("\r", "");
        return flat.length() <= 80 ? flat : flat.substring(0, 77) + "...";
    }

    @NotNull
    private static String normalizePath(@NotNull String filePath) {
        try {
            Path path = Paths.get(filePath);
            return path.toAbsolutePath().normalize().toString().replace('\\', '/');
        } catch (Exception e) {
            return filePath.replace('\\', '/');
        }
    }

    public interface BrowserCallbacks {
        void sendRemoveFileFromEdits(@NotNull String filePath);

        void sendDiffResult(@NotNull String filePath, @NotNull String action, @Nullable String content, @Nullable String error);
    }

    public static final class PendingFileChangePayload {
        public String filePath;
        public String fileName;
        public String status;
        public List<EditOperation> operations = new ArrayList<>();
    }

    public enum FileStatus {
        ADDED,
        MODIFIED;

        public static FileStatus fromRaw(@Nullable String raw) {
            return "A".equalsIgnoreCase(raw) ? ADDED : MODIFIED;
        }
    }

    public static final class EditOperation {
        public String oldString = "";
        public String newString = "";
        public boolean replaceAll;
    }

    public static final class PendingFileChange {
        private final String filePath;
        private final String fileName;
        private final FileStatus status;
        private final String frontendPayloadSignature;
        private final long conflictSuppressedUntilMs;
        private String baselineContent;
        private String lastSyncedCurrentContent;
        private List<InlineDiffHunk> pendingHunks;
        private boolean detachedFromFrontend;
        private boolean conflicted;

        private PendingFileChange(
                @NotNull String filePath,
                @NotNull String fileName,
                @NotNull FileStatus status,
                @NotNull String frontendPayloadSignature,
                @NotNull String baselineContent,
                @NotNull List<InlineDiffHunk> pendingHunks,
                @NotNull String currentContent
        ) {
            this.filePath = filePath;
            this.fileName = fileName;
            this.status = status;
            this.frontendPayloadSignature = frontendPayloadSignature;
            this.conflictSuppressedUntilMs = System.currentTimeMillis() + CONFLICT_SUPPRESSION_MS;
            this.baselineContent = InlineDiffUtil.normalize(baselineContent);
            this.lastSyncedCurrentContent = InlineDiffUtil.normalize(currentContent);
            this.pendingHunks = new ArrayList<>(pendingHunks);
        }

        @NotNull
        public String getFilePath() {
            return filePath;
        }

        @NotNull
        public String getFileName() {
            return fileName;
        }

        public boolean isConflicted() {
            return conflicted;
        }

        public boolean isDetachedFromFrontend() {
            return detachedFromFrontend;
        }

        public boolean hasSameFrontendPayload(@NotNull PendingFileChange other) {
            return frontendPayloadSignature.equals(other.frontendPayloadSignature);
        }

        public int getPendingHunkCount() {
            return pendingHunks.size();
        }

        public boolean hasPendingHunks() {
            return !pendingHunks.isEmpty();
        }

        @NotNull
        public List<InlineDiffHunk> getPendingHunks() {
            return new ArrayList<>(pendingHunks);
        }

        @Nullable
        public InlineDiffHunk findHunk(@NotNull String hunkId) {
            for (InlineDiffHunk hunk : pendingHunks) {
                if (hunk.getHunkId().equals(hunkId)) {
                    return hunk;
                }
            }
            return null;
        }
    }

    private static final class HunkNavigationTarget {
        private final String filePath;
        private final int nextHunkIndex;
        private final String nextFilePath;

        private HunkNavigationTarget(
                @NotNull String filePath,
                int nextHunkIndex,
                @Nullable String nextFilePath
        ) {
            this.filePath = filePath;
            this.nextHunkIndex = nextHunkIndex;
            this.nextFilePath = nextFilePath;
        }
    }

    /**
     * EDT watchdog: monitors EDT responsiveness.  If the EDT is blocked for
     * more than 3 seconds, dumps the stack traces of EDT, JCEF and Coroutine
     * threads to idea.log with [EDT-DIAG] prefix.
     */
    private static final class EdtWatchdog {
        private static volatile Thread watchdogThread;

        static void start(@NotNull Disposable parent) {
            Thread t = new Thread(() -> {
                while (!Thread.currentThread().isInterrupted()) {
                    try {
                        Thread.sleep(500);
                    } catch (InterruptedException e) {
                        return;
                    }
                    long start = System.nanoTime();
                    CountDownLatch latch = new CountDownLatch(1);
                    ApplicationManager.getApplication().invokeLater(latch::countDown);
                    try {
                        if (!latch.await(3, TimeUnit.SECONDS)) {
                            long elapsed = (System.nanoTime() - start) / 1_000_000;
                            LOG.warn("[EDT-DIAG] EDT BLOCKED for " + elapsed + "ms! Thread dump:");
                            for (Map.Entry<Thread, StackTraceElement[]> entry : Thread.getAllStackTraces().entrySet()) {
                                Thread thread = entry.getKey();
                                String name = thread.getName();
                                if (name.contains("AWT-EventQueue")
                                        || name.contains("JCEF")
                                        || name.contains("Coroutine")) {
                                    StringBuilder sb = new StringBuilder();
                                    sb.append("[EDT-DIAG]   Thread: ").append(name)
                                            .append(" state=").append(thread.getState());
                                    for (StackTraceElement ste : entry.getValue()) {
                                        sb.append("\n[EDT-DIAG]     at ").append(ste);
                                    }
                                    LOG.warn(sb.toString());
                                }
                            }
                        }
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            }, "EDT-Watchdog-ClaudeInlineReview");
            t.setDaemon(true);
            t.start();
            watchdogThread = t;
        }

        static void stop() {
            Thread t = watchdogThread;
            if (t != null) {
                t.interrupt();
                watchdogThread = null;
            }
        }
    }
}
