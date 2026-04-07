package com.github.claudecodegui.permission;

import com.github.claudecodegui.handler.diff.DiffResult;
import com.github.claudecodegui.handler.diff.InteractiveDiffRequest;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.intellij.diff.DiffDialogHints;
import com.intellij.diff.DiffManagerEx;
import com.intellij.diff.chains.SimpleDiffRequestChain;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.EditorNotifications;
import com.intellij.util.messages.MessageBusConnection;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.File;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Project-level queue for read-only diff approvals.
 * Keeps pending file reviews stable even when the user closes a diff tab,
 * and exposes navigation/count state for native IDE UI surfaces.
 */
@Service(Service.Level.PROJECT)
public final class DiffApprovalQueueService implements Disposable {

    private static final Logger LOG = Logger.getInstance(DiffApprovalQueueService.class);

    private final Project project;
    private final Map<String, PendingReview> pendingReviews = new LinkedHashMap<>();

    public DiffApprovalQueueService(@NotNull Project project) {
        this.project = project;
    }

    public static DiffApprovalQueueService getInstance(@NotNull Project project) {
        return project.getService(DiffApprovalQueueService.class);
    }

    @NotNull
    public Registration registerReview(
            @NotNull InteractiveDiffRequest request,
            @NotNull CompletableFuture<DiffResult> resultFuture
    ) {
        String reviewId = UUID.randomUUID().toString();
        PendingReview review = new PendingReview(
                reviewId,
                normalizePath(request.getFilePath()),
                new File(request.getFilePath()).getName(),
                request.getNewFileContents(),
                resultFuture
        );

        boolean openImmediately;
        synchronized (this) {
            openImmediately = pendingReviews.isEmpty();
            pendingReviews.put(reviewId, review);
        }

        LOG.info("Queued diff approval reviewId=" + reviewId + ", file=" + request.getFilePath()
                + ", openImmediately=" + openImmediately);
        refreshUiState();
        return new Registration(reviewId, openImmediately);
    }

    public void attachDiffChain(@NotNull String reviewId, @NotNull SimpleDiffRequestChain chain) {
        synchronized (this) {
            PendingReview review = pendingReviews.get(reviewId);
            if (review != null) {
                review.diffChain = chain;
            }
        }
    }

    public void attachConnection(@NotNull String reviewId, @NotNull MessageBusConnection connection) {
        synchronized (this) {
            PendingReview review = pendingReviews.get(reviewId);
            if (review != null) {
                review.connection = connection;
            }
        }
    }

    public void attachDiffVirtualFile(@NotNull String reviewId, @NotNull VirtualFile diffVirtualFile) {
        synchronized (this) {
            PendingReview review = pendingReviews.get(reviewId);
            if (review != null) {
                review.diffVirtualFile = diffVirtualFile;
            }
        }
    }

    public void detachDiffVirtualFile(@NotNull String reviewId, @NotNull VirtualFile diffVirtualFile) {
        synchronized (this) {
            PendingReview review = pendingReviews.get(reviewId);
            if (review != null && review.diffVirtualFile == diffVirtualFile) {
                review.diffVirtualFile = null;
            }
        }
    }

    public int getPendingCount() {
        synchronized (this) {
            return pendingReviews.size();
        }
    }

    public int getRemainingCount(@Nullable String currentReviewId) {
        synchronized (this) {
            int count = pendingReviews.size();
            if (currentReviewId != null && pendingReviews.containsKey(currentReviewId)) {
                return Math.max(0, count - 1);
            }
            return count;
        }
    }

    @Nullable
    public PendingReview getPendingReviewForFile(@NotNull String filePath) {
        String normalized = normalizePath(filePath);
        synchronized (this) {
            for (PendingReview review : pendingReviews.values()) {
                if (review.filePath.equals(normalized)) {
                    return review;
                }
            }
        }
        return null;
    }

    @Nullable
    public String getNextPendingFileName(@Nullable String currentReviewId) {
        synchronized (this) {
            String nextReviewId = getNextPendingReviewIdLocked(currentReviewId);
            PendingReview next = nextReviewId != null ? pendingReviews.get(nextReviewId) : null;
            return next != null ? next.fileName : null;
        }
    }

    public void activateReview(@NotNull String reviewId) {
        PendingReview review;
        synchronized (this) {
            review = pendingReviews.get(reviewId);
        }
        if (review == null) {
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }

            try {
                if (review.diffVirtualFile != null && review.diffVirtualFile.isValid()) {
                    FileEditorManager.getInstance(project).openFile(review.diffVirtualFile, true);
                    return;
                }
                if (review.diffChain != null) {
                    DiffManagerEx.getInstance().showDiffBuiltin(project, review.diffChain, DiffDialogHints.DEFAULT);
                }
            } catch (Exception e) {
                LOG.warn("Failed to activate diff review for " + review.filePath, e);
            }
        });
    }

    public void activateNextPendingReview(@Nullable String currentReviewId) {
        String nextReviewId;
        synchronized (this) {
            nextReviewId = getNextPendingReviewIdLocked(currentReviewId);
        }
        if (nextReviewId != null) {
            activateReview(nextReviewId);
        }
    }

    public boolean approveReview(@NotNull String reviewId) {
        return resolveReview(reviewId, DiffResult.apply(getProposedContent(reviewId)));
    }

    public boolean approveReviewAlways(@NotNull String reviewId) {
        return resolveReview(reviewId, DiffResult.applyAlways(getProposedContent(reviewId)));
    }

    public boolean rejectReview(@NotNull String reviewId) {
        return resolveReview(reviewId, DiffResult.reject());
    }

    public boolean dismissReview(@NotNull String reviewId) {
        return resolveReview(reviewId, DiffResult.dismiss());
    }

    @Override
    public void dispose() {
        List<PendingReview> reviewsToReject;
        synchronized (this) {
            reviewsToReject = new ArrayList<>(pendingReviews.values());
            pendingReviews.clear();
        }

        for (PendingReview review : reviewsToReject) {
            disconnect(review);
            closeDiffFile(review);
            if (!review.resultFuture.isDone()) {
                review.resultFuture.complete(DiffResult.reject());
            }
        }
        refreshUiState();
    }

    private boolean resolveReview(@NotNull String reviewId, @NotNull DiffResult result) {
        PendingReview review;
        boolean hadVisibleDiff;
        synchronized (this) {
            review = pendingReviews.remove(reviewId);
            if (review == null || review.resolved) {
                return false;
            }
            review.resolved = true;
            hadVisibleDiff = review.diffVirtualFile != null;
        }

        disconnect(review);
        closeDiffFile(review);
        review.resultFuture.complete(result);
        refreshUiState();
        if (hadVisibleDiff) {
            activateNextPendingReview(null);
        }
        return true;
    }

    @NotNull
    private String getProposedContent(@NotNull String reviewId) {
        synchronized (this) {
            PendingReview review = pendingReviews.get(reviewId);
            return review != null ? review.proposedContent : "";
        }
    }

    @Nullable
    private String getNextPendingReviewIdLocked(@Nullable String currentReviewId) {
        if (pendingReviews.isEmpty()) {
            return null;
        }

        List<String> reviewIds = new ArrayList<>(pendingReviews.keySet());
        if (currentReviewId == null) {
            return reviewIds.get(0);
        }

        int index = reviewIds.indexOf(currentReviewId);
        if (index < 0) {
            return reviewIds.get(0);
        }
        return reviewIds.get((index + 1) % reviewIds.size());
    }

    private void disconnect(@NotNull PendingReview review) {
        MessageBusConnection connection = review.connection;
        review.connection = null;
        if (connection != null) {
            try {
                connection.disconnect();
            } catch (Exception e) {
                LOG.debug("Failed to disconnect diff review listener", e);
            }
        }
    }

    private void closeDiffFile(@NotNull PendingReview review) {
        VirtualFile diffFile = review.diffVirtualFile;
        review.diffVirtualFile = null;
        if (diffFile == null) {
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            if (!project.isDisposed() && diffFile.isValid()) {
                FileEditorManager.getInstance(project).closeFile(diffFile);
            }
        });
    }

    private void refreshUiState() {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }

            try {
                // Targeted: only update the currently visible editor instead of
                // the expensive updateAllNotifications() which iterates ALL editors.
                EditorNotifications notifications = EditorNotifications.getInstance(project);
                com.intellij.openapi.fileEditor.FileEditor selected =
                        FileEditorManager.getInstance(project).getSelectedEditor();
                if (selected != null && selected.getFile() != null) {
                    notifications.updateNotifications(selected.getFile());
                }
            } catch (Exception e) {
                LOG.debug("Failed to refresh editor notifications", e);
            }

            ClaudeNotifier.setPendingReviews(project, getPendingCount());
        });
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

    public static final class Registration {
        private final String reviewId;
        private final boolean openImmediately;

        private Registration(@NotNull String reviewId, boolean openImmediately) {
            this.reviewId = reviewId;
            this.openImmediately = openImmediately;
        }

        @NotNull
        public String getReviewId() {
            return reviewId;
        }

        public boolean isOpenImmediately() {
            return openImmediately;
        }
    }

    public static final class PendingReview {
        private final String reviewId;
        private final String filePath;
        private final String fileName;
        private final String proposedContent;
        private final CompletableFuture<DiffResult> resultFuture;
        private volatile boolean resolved;
        private volatile SimpleDiffRequestChain diffChain;
        private volatile VirtualFile diffVirtualFile;
        private volatile MessageBusConnection connection;

        private PendingReview(
                @NotNull String reviewId,
                @NotNull String filePath,
                @NotNull String fileName,
                @NotNull String proposedContent,
                @NotNull CompletableFuture<DiffResult> resultFuture
        ) {
            this.reviewId = reviewId;
            this.filePath = filePath;
            this.fileName = fileName;
            this.proposedContent = proposedContent;
            this.resultFuture = resultFuture;
        }

        @NotNull
        public String getReviewId() {
            return reviewId;
        }

        @NotNull
        public String getFileName() {
            return fileName;
        }

        @NotNull
        public String getFilePath() {
            return filePath;
        }
    }
}
