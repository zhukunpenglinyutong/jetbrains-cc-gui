package com.github.claudecodegui.markdown;

import com.google.gson.Gson;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.components.PersistentStateComponent;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.components.State;
import com.intellij.openapi.components.Storage;
import com.intellij.openapi.components.StoragePathMacros;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.RangeMarker;
import com.intellij.openapi.editor.event.DocumentEvent;
import com.intellij.openapi.editor.event.DocumentListener;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import org.jetbrains.annotations.NotNull;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.Base64;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Project-owned state; no Markdown-plugin types leak into core chat classes. */
@Service(Service.Level.PROJECT)
@State(name = "CCGuiMarkdownReview", storages = @Storage(StoragePathMacros.WORKSPACE_FILE))
public final class MarkdownReviewService implements PersistentStateComponent<MarkdownReviewService.State>, Disposable {

    /** How a document edit relates to the tracked annotations; drives the refresh level. */
    public enum EditImpact {
        /** The edit is past every annotation: nothing moves, nothing is re-checked. */
        NONE,
        /** The edit only shifted annotation positions; a light position refresh suffices. */
        SHIFT,
        /** The edit overlapped an annotated range: full validation and cleanup are required. */
        HIT
    }

    private static final com.intellij.openapi.diagnostic.Logger LOG =
            com.intellij.openapi.diagnostic.Logger.getInstance(MarkdownReviewService.class);

    public static final class State {
        public int schemaVersion = 3;
        public long nextAnnotationId;
        public MarkdownReviewConfig config = new MarkdownReviewConfig();
        public String encodedPayload;
        public String recoveryPayload;
        public List<Annotation> annotations = new ArrayList<>();
        public List<ReviewBatch> batches = new ArrayList<>();
    }

    private static final Gson GSON = new Gson();
    private State state = new State();
    private final List<Consumer<EditImpact>> listeners = new CopyOnWriteArrayList<>();
    private final Map<String, RangeMarker> markers = new HashMap<>();
    private final Set<Document> documents = new HashSet<>();

    public MarkdownReviewService(Project project) {
        if (project == null) {
            return; // State-only unit tests do not need an IDE application.
        }
        project.getMessageBus().connect(this).subscribe(VirtualFileManager.VFS_CHANGES, new BulkFileListener() {
            private final Map<VirtualFile, String> previous = new HashMap<>();

            @Override
            public void before(@NotNull List<? extends VFileEvent> events) {
                for (VFileEvent event : events) {
                    VirtualFile file = event.getFile();
                    if (file != null) {
                        previous.put(file, file.getUrl());
                    }
                }
            }

            @Override
            public void after(@NotNull List<? extends VFileEvent> events) {
                boolean modified = false;
                synchronized (MarkdownReviewService.this) {
                    for (Map.Entry<VirtualFile, String> entry : previous.entrySet()) {
                        VirtualFile file = entry.getKey();
                        for (Annotation annotation : state.annotations) {
                            if (entry.getValue().equals(annotation.fileUrl)) {
                                modified |= !file.isValid() || !annotation.fileUrl.equals(file.getUrl());
                                annotation.fileUrl = file.getUrl();
                                String base = project.getBasePath();
                                annotation.path = base != null && file.getPath().startsWith(base + "/")
                                        ? file.getPath().substring(base.length() + 1) : file.getPath();
                                if (!file.isValid()) {
                                    annotation.status = "orphaned";
                                }
                            }
                        }
                    }
                    previous.clear();
                }
                if (modified) {
                    changed();
                }
            }
        });
    }

    public static MarkdownReviewService getInstance(Project project) {
        return project.getService(MarkdownReviewService.class);
    }

    @Override
    public synchronized @NotNull State getState() {
        State saved = new State();
        saved.nextAnnotationId = state.nextAnnotationId;
        saved.config = getConfig();
        if (!state.config.persist) {
            return saved;
        }
        // XMLB can discard supplementary Unicode characters in string fields.
        // Store an ASCII envelope so quotes, emoji and source anchors survive
        // the IDE's XML serialization without altering the in-memory model.
        StringBuilder json = new StringBuilder();
        for (char character : GSON.toJson(state).toCharArray()) {
            // Context boundaries may also split a UTF-16 surrogate pair.
            // Escape code units before UTF-8 encoding to retain those exactly.
            if (Character.isSurrogate(character)) {
                json.append(String.format("\\u%04x", (int) character));
            } else {
                json.append(character);
            }
        }
        saved.encodedPayload = Base64.getEncoder().encodeToString(json.toString().getBytes(StandardCharsets.UTF_8));
        saved.recoveryPayload = state.recoveryPayload;
        return saved;
    }

    public synchronized State snapshotState() {
        return copy(state, State.class);
    }

    @Override
    public synchronized void loadState(@NotNull State saved) {
        MarkdownReviewConfig config = saved.config == null ? new MarkdownReviewConfig() : saved.config;
        if (!config.persist) {
            State transientState = new State();
            transientState.nextAnnotationId = saved.nextAnnotationId;
            transientState.config = copy(config, MarkdownReviewConfig.class);
            state = transientState;
            return;
        }
        if (saved.encodedPayload != null) {
            String originalPayload = saved.encodedPayload;
            try {
                saved = GSON.fromJson(new String(Base64.getDecoder().decode(saved.encodedPayload), StandardCharsets.UTF_8), State.class);
                if (saved == null) {
                    throw new IllegalArgumentException("Empty Markdown review state");
                }
            } catch (RuntimeException error) {
                State recoverable = new State();
                recoverable.recoveryPayload = originalPayload;
                com.intellij.openapi.diagnostic.Logger.getInstance(MarkdownReviewService.class).warn("Unable to restore Markdown reviews; preserving the encoded data", error);
                saved = recoverable;
            }
        }
        // Legacy state with XML lists is accepted for migration.
        saved.encodedPayload = null;
        saved.schemaVersion = 3;
        saved.config = copy(config, MarkdownReviewConfig.class);
        if (saved.annotations == null) {
            saved.annotations = new ArrayList<>();
        }
        if (saved.batches == null) {
            saved.batches = new ArrayList<>();
        }
        state = copy(saved, State.class);
        // Migrate UUID-era live annotations and pending snapshots together.
        Map<String, String> migratedIds = new HashMap<>();
        List<Annotation> stored = new ArrayList<>(state.annotations);
        for (ReviewBatch batch : state.batches) {
            stored.addAll(batch.annotations);
        }
        for (Annotation annotation : stored) {
            if (annotation.id != null && annotation.id.matches("[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")) {
                annotation.id = migratedIds.computeIfAbsent(annotation.id, ignored -> nextAnnotationId());
            }
        }
    }

    public synchronized MarkdownReviewConfig getConfig() {
        return copy(state.config, MarkdownReviewConfig.class);
    }

    public void configure(MarkdownReviewConfig config) {
        synchronized (this) {
            state.config = copy(config, MarkdownReviewConfig.class);
            if (!config.persist) {
                state.recoveryPayload = null;
            }
        }
        changed();
    }

    public void subscribe(Consumer<EditImpact> listener) {
        listeners.add(listener);
    }

    public void refreshPreviewSettings() {
        changed();
    }

    public void unsubscribe(Consumer<EditImpact> listener) {
        listeners.remove(listener);
    }

    public synchronized List<Annotation> list(VirtualFile file) {
        List<Annotation> result = new ArrayList<>();
        for (Annotation annotation : state.annotations) {
            if (file.getUrl().equals(annotation.fileUrl) && !annotation.sourceMissing && "attached".equals(annotation.status)) {
                result.add(copy(annotation, Annotation.class));
            }
        }
        return result;
    }

    public Annotation create(VirtualFile file, String path, Document document, int start, int end, String selected, String comment) {
        if (comment.isBlank()) {
            throw new IllegalArgumentException("Comment cannot be empty");
        }
        Annotation annotation = snapshot(file, path, document, start, end, selected, comment);
        synchronized (this) {
            if (!state.config.enabled) {
                throw new IllegalStateException("Markdown annotations are disabled in CC GUI settings.");
            }
            state.annotations.add(annotation);
            track(annotation, document);
        }
        changed();
        return copy(annotation, Annotation.class);
    }

    synchronized String nextAnnotationId() {
        String id;
        do {
            id = Long.toString(state.nextAnnotationId++, 36);
            id = "0".repeat(Math.max(0, 4 - id.length())) + id;
        } while (annotationIdExists(id));
        return id;
    }

    private boolean annotationIdExists(String id) {
        return state.annotations.stream().anyMatch(item -> id.equals(item.id))
                || state.batches.stream().anyMatch(batch -> batch.annotations.stream().anyMatch(item -> id.equals(item.id)));
    }

    public Annotation snapshot(VirtualFile file, String path, Document document, int start, int end, String selected, String comment) {
        if (start < 0 || end <= start || end > document.getTextLength() || selected.isBlank()
                || selected.length() > MarkdownReviewLimits.TEXT_MAX_CHARS
                || comment.length() > MarkdownReviewLimits.TEXT_MAX_CHARS
                || end - start > MarkdownReviewLimits.SPAN_MAX_CHARS) {
            throw new IllegalArgumentException("Invalid selection or empty comment");
        }
        String source = document.getText().substring(start, end);
        Annotation annotation = new Annotation();
        annotation.sourceContext = source;
        int match = source.indexOf(selected);
        if (match >= 0 && source.indexOf(selected, match + 1) < 0) {
            start += match;
            end = start + selected.length();
            source = selected;
            annotation.precision = "source";
        }
        annotation.id = nextAnnotationId();
        annotation.fileUrl = file.getUrl();
        annotation.path = path;
        annotation.start = start;
        annotation.end = end;
        annotation.startLine = document.getLineNumber(start) + 1;
        annotation.endLine = document.getLineNumber(Math.max(start, end - 1)) + 1;
        annotation.selectedText = selected;
        annotation.sourceText = source;
        annotation.prefix = document.getText().substring(Math.max(0, start - 48), start);
        annotation.suffix = document.getText().substring(end, Math.min(document.getTextLength(), end + 48));
        annotation.comment = comment;
        return annotation;
    }

    public void update(VirtualFile file, String id, long revision, String comment, boolean delete) {
        synchronized (this) {
            Annotation annotation = find(file, id);
            if (annotation.revision != revision) {
                throw new IllegalStateException("This comment changed in another preview. Reopen it and try again.");
            }
            if (delete) {
                state.annotations.remove(annotation);
                RangeMarker marker = markers.remove(id);
                if (marker != null) {
                    marker.dispose();
                }
            } else {
                if (comment.isBlank() || comment.length() > MarkdownReviewLimits.TEXT_MAX_CHARS) {
                    throw new IllegalArgumentException("Comment cannot be empty");
                }
                annotation.comment = comment;
                annotation.revision++;
            }
        }
        changed();
    }

    public void complete(VirtualFile file, String id, long revision, boolean completed) {
        synchronized (this) {
            Annotation annotation = find(file, id);
            if (annotation.revision != revision) {
                throw new IllegalStateException("This comment changed. Reopen it and try again.");
            }
            annotation.completed = completed;
            if (completed) {
                // Completing a review explicitly archives it in the workspace.
                state.config.persist = true;
            }
            annotation.revision++;
        }
        changed();
    }

    private Annotation find(VirtualFile file, String id) {
        for (Annotation annotation : state.annotations) {
            if (file.getUrl().equals(annotation.fileUrl) && annotation.id.equals(id)) {
                return annotation;
            }
        }
        throw new IllegalArgumentException("Comment no longer exists");
    }

    public void reconcile(VirtualFile file, Document document) {
        boolean modified = false;
        synchronized (this) {
            String text = document.getText();
            for (Annotation annotation : state.annotations) {
                if (!file.getUrl().equals(annotation.fileUrl) || annotation.sourceMissing) {
                    continue;
                }
                RangeMarker marker = markers.get(annotation.id);
                int offset;
                if (marker != null && marker.isValid()) {
                    // Do not jump to an unrelated duplicate after the live
                    // annotated range was edited or deleted.
                    offset = text.substring(marker.getStartOffset(), marker.getEndOffset()).equals(annotation.sourceText)
                            ? marker.getStartOffset() : -1;
                } else {
                    offset = AnnotationAnchorResolver.relocate(text, annotation.sourceText,
                            annotation.start, annotation.prefix, annotation.suffix);
                }
                String status = offset >= 0 ? "attached" : (offset == -2 ? "ambiguous" : "orphaned");
                if (!status.equals(annotation.status) || offset >= 0 && offset != annotation.start) {
                    modified = true;
                }
                annotation.status = status;
                if (offset == -1) {
                    annotation.sourceMissing = true;
                }
                if (offset >= 0) {
                    annotation.start = offset;
                    annotation.end = offset + annotation.sourceText.length();
                    annotation.startLine = document.getLineNumber(offset) + 1;
                    annotation.endLine = document.getLineNumber(Math.max(offset, annotation.end - 1)) + 1;
                    track(annotation, document);
                }
            }
        }
        if (modified) {
            changed();
        }
    }

    private void track(Annotation annotation, Document document) {
        RangeMarker previous = markers.get(annotation.id);
        if (previous == null || !previous.isValid() || previous.getStartOffset() != annotation.start || previous.getEndOffset() != annotation.end) {
            if (previous != null) {
                previous.dispose();
            }
            markers.put(annotation.id, document.createRangeMarker(annotation.start, annotation.end));
        }
        if (documents.add(document)) {
            document.addDocumentListener(new DocumentListener() {
                private final Set<String> affected = new HashSet<>();

                @Override
                public void beforeDocumentChange(@NotNull DocumentEvent event) {
                    affected.clear();
                    int[] range = changedRange(event.getOffset(), event.getOldFragment(), event.getNewFragment());
                    synchronized (MarkdownReviewService.this) {
                        for (Annotation item : state.annotations) {
                            RangeMarker marker = markers.get(item.id);
                            if (marker != null && marker.getDocument() == document && marker.isValid()
                                    && overlaps(range, marker.getStartOffset(), marker.getEndOffset())
                                    && !(event.getOffset() <= marker.getStartOffset()
                                    && event.getOffset() + event.getOldLength() >= marker.getEndOffset()
                                    && preservesSource(event.getOldFragment(), event.getNewFragment(), item.sourceText))) {
                                affected.add(item.id);
                            }
                        }
                    }
                }

                @Override
                public void documentChanged(@NotNull DocumentEvent event) {
                    boolean hit = !affected.isEmpty();
                    EditImpact impact;
                    synchronized (MarkdownReviewService.this) {
                        if (hit && state.config.enabled && state.config.autoDeleteAffected) {
                            state.annotations.removeIf(item -> {
                                if (!affected.contains(item.id) || item.completed) {
                                    return false;
                                }
                                RangeMarker removed = markers.remove(item.id);
                                if (removed != null) {
                                    removed.dispose();
                                }
                                return true;
                            });
                        }
                        affected.clear();
                        if (!state.config.enabled) {
                            // Disabled: positions are reconciled by the next sync after re-enabling.
                            return;
                        }
                        impact = classifyImpact(state.annotations, event.getOffset(), hit);
                        if (impact == EditImpact.NONE) {
                            // The edit is past every annotation: no refresh, no fan-out.
                            return;
                        }
                        for (Annotation item : state.annotations) {
                            if (item.sourceMissing) {
                                continue;
                            }
                            RangeMarker marker = markers.get(item.id);
                            if (marker != null && marker.getDocument() == document && marker.isValid()) {
                                item.start = marker.getStartOffset();
                                item.end = marker.getEndOffset();
                                item.startLine = document.getLineNumber(item.start) + 1;
                                item.endLine = document.getLineNumber(Math.max(item.start, item.end - 1)) + 1;
                                item.status = document.getText().substring(item.start, item.end).equals(item.sourceText) ? "attached" : "orphaned";
                            } else if (marker != null && marker.getDocument() == document) {
                                item.status = "orphaned";
                            }
                            if ("orphaned".equals(item.status)) {
                                item.sourceMissing = true;
                            }
                        }
                    }
                    changed(impact);
                }
            }, this);
        }
    }

    /** Trim common edges, so a whole-file save that only prepends text does not clear every review. */
    static boolean affectsRange(int offset, CharSequence oldText, CharSequence newText, int start, int end) {
        return overlaps(changedRange(offset, oldText, newText), start, end);
    }

    private static boolean overlaps(int[] range, int start, int end) {
        return range != null && (range[0] == range[1] ? range[0] > start && range[0] < end
                : range[0] < end && range[1] > start);
    }

    /** Whole-file rewrites can cover an unchanged review between two actual edits. */
    static boolean preservesSource(CharSequence oldText, CharSequence newText, String source) {
        if (source == null || source.isEmpty()) {
            return false;
        }
        String before = oldText.toString();
        String after = newText.toString();
        int oldMatch = before.indexOf(source);
        int newMatch = after.indexOf(source);
        return oldMatch >= 0 && newMatch >= 0 && before.indexOf(source, oldMatch + 1) < 0
                && after.indexOf(source, newMatch + 1) < 0;
    }

    /**
     * Classifies an edit against tracked positions: HIT when the edit overlapped an annotated
     * range, SHIFT when any tracked annotation starts at or after the edit point (it will
     * shift), otherwise NONE. Pure function for unit tests.
     */
    static EditImpact classifyImpact(List<Annotation> annotations, int editOffset, boolean hitAffected) {
        if (hitAffected) {
            return EditImpact.HIT;
        }
        for (Annotation item : annotations) {
            if (!item.sourceMissing && item.start >= editOffset) {
                return EditImpact.SHIFT;
            }
        }
        return EditImpact.NONE;
    }

    private static int[] changedRange(int offset, CharSequence oldText, CharSequence newText) {
        int prefix = 0;
        while (prefix < oldText.length() && prefix < newText.length() && oldText.charAt(prefix) == newText.charAt(prefix)) {
            prefix++;
        }
        int oldEnd = oldText.length();
        int newEnd = newText.length();
        while (oldEnd > prefix && newEnd > prefix && oldText.charAt(oldEnd - 1) == newText.charAt(newEnd - 1)) {
            oldEnd--;
            newEnd--;
        }
        if (oldEnd == prefix && newEnd == prefix) {
            return null;
        }
        return new int[] {offset + prefix, offset + oldEnd};
    }

    public synchronized ReviewBatch saveBatch(ReviewBatch batch) {
        // A retry must not add another copy to the same chat input.
        for (ReviewBatch existing : state.batches) {
            if (isPending(existing) && existing.targetId.equals(batch.targetId) && existing.targetEpoch.equals(batch.targetEpoch)
                    && existing.path.equals(batch.path) && existing.documentHash.equals(batch.documentHash)
                    && existing.kind.equals(batch.kind) && existing.autoDeleteAffected == batch.autoDeleteAffected
                    && existing.automatic == batch.automatic
                    && sameAnnotations(existing, batch)) {
                return copy(existing, ReviewBatch.class);
            }
        }
        // Editing an automatically added comment supersedes only its unsent
        // automatic draft. Queued snapshots and manual transfers remain frozen.
        if (batch.automatic && batch.annotations.size() == 1) {
            for (ReviewBatch existing : state.batches) {
                if (existing.automatic && isPending(existing) && existing.targetId.equals(batch.targetId)
                        && existing.targetEpoch.equals(batch.targetEpoch) && existing.path.equals(batch.path)
                        && existing.annotations.size() == 1
                        && existing.annotations.get(0).id.equals(batch.annotations.get(0).id)) {
                    existing.state = "removed";
                }
            }
        }
        // Keep handoff snapshots for diagnosis/recovery; "queued" does not
        // mean the provider acknowledged receipt. When the bounded history is
        // full, evict in order: the oldest terminal snapshot, the oldest
        // pending snapshot of a retired chat target, or the oldest pending
        // snapshot — the feature must never lock up on orphans.
        while (state.batches.size() >= MarkdownReviewLimits.MAX_PENDING_BATCHES) {
            ReviewBatch victim = pickVictim();
            if (victim == null) {
                break;
            }
            state.batches.remove(victim);
        }
        if (state.batches.size() >= MarkdownReviewLimits.MAX_PENDING_BATCHES) {
            throw new IllegalStateException("Review draft limit reached. Remove old drafts before adding more.");
        }
        state.batches.add(copy(batch, ReviewBatch.class));
        return copy(batch, ReviewBatch.class);
    }

    /** Chat targets that can still acknowledge drafts. Registered by the tool window on the EDT;
     * the default "all targets retired" keeps state-only unit tests on the orphan-eviction tier. */
    private Supplier<Set<String>> liveTargets = Set::of;

    public void setLiveTargetsSupplier(Supplier<Set<String>> supplier) {
        liveTargets = java.util.Objects.requireNonNull(supplier);
    }

    /** Caller must hold the monitor. */
    private ReviewBatch pickVictim() {
        Set<String> alive = liveTargets.get();
        ReviewBatch victim = state.batches.stream().filter(item -> !isPending(item)).findFirst().orElse(null);
        if (victim == null) {
            victim = state.batches.stream()
                    .filter(item -> isPending(item) && !alive.contains(item.targetId))
                    .findFirst().orElse(null);
        }
        if (victim == null) {
            victim = state.batches.stream().filter(MarkdownReviewService::isPending).findFirst().orElse(null);
        }
        return victim;
    }

    /**
     * Drops every unacknowledged snapshot registered for a retired chat target. Only handoff
     * records are removed; the annotations themselves stay for a later re-transfer.
     */
    public synchronized int dropPending(String targetId) {
        int dropped = 0;
        for (java.util.Iterator<ReviewBatch> iterator = state.batches.iterator(); iterator.hasNext(); ) {
            ReviewBatch batch = iterator.next();
            if (targetId.equals(batch.targetId) && isPending(batch)) {
                iterator.remove();
                dropped++;
            }
        }
        return dropped;
    }

    public synchronized List<ReviewBatch> pending(String targetId, String epoch, String sessionId, boolean allowRecovery) {
        List<ReviewBatch> result = new ArrayList<>();
        for (ReviewBatch batch : state.batches) {
            if (targetId.equals(batch.targetId) && isPending(batch)
                    && (epoch.equals(batch.targetEpoch) || allowRecovery && java.util.Objects.equals(sessionId, batch.targetSessionId))) {
                batch.targetEpoch = epoch;
                batch.targetSessionId = sessionId;
                result.add(copy(batch, ReviewBatch.class));
            }
        }
        return result;
    }

    public synchronized void bindSession(String targetId, String epoch, String sessionId) {
        for (ReviewBatch batch : state.batches) {
            if (targetId.equals(batch.targetId) && epoch.equals(batch.targetEpoch)) {
                batch.targetSessionId = sessionId;
            }
        }
    }

    public synchronized void acknowledge(String targetId, String epoch, String batchId, String status, List<String> annotationIds) {
        if (annotationIds == null || !Set.of("received", "queued", "removed").contains(status)) {
            return;
        }
        for (ReviewBatch batch : state.batches) {
            if (batch.id.equals(batchId) && batch.targetId.equals(targetId) && batch.targetEpoch.equals(epoch)) {
                if (!isPending(batch)) {
                    return;
                }
                batch.annotations.removeIf(item -> !annotationIds.contains(item.id));
                batch.state = batch.annotations.isEmpty() ? "removed" : status;
                return;
            }
        }
    }

    private static boolean isPending(ReviewBatch batch) {
        return "pending".equals(batch.state) || "received".equals(batch.state);
    }

    private static boolean sameAnnotations(ReviewBatch left, ReviewBatch right) {
        if (left.annotations.size() != right.annotations.size()) {
            return false;
        }
        for (int index = 0; index < left.annotations.size(); index++) {
            Annotation a = left.annotations.get(index);
            Annotation b = right.annotations.get(index);
            if (!a.id.equals(b.id) || !a.selectedText.equals(b.selectedText) || !a.sourceText.equals(b.sourceText)
                    || !a.comment.equals(b.comment) || a.revision != b.revision || a.start != b.start) {
                return false;
            }
        }
        return true;
    }

    private void changed() {
        changed(EditImpact.HIT);
    }

    private void changed(EditImpact impact) {
        for (Consumer<EditImpact> listener : listeners) {
            try {
                listener.accept(impact);
            } catch (RuntimeException error) {
                // One misbehaving preview panel must not cut off the remaining listeners.
                LOG.warn("Markdown review listener failed", error);
            }
        }
    }

    private static <T> T copy(T value, Class<T> type) {
        return GSON.fromJson(GSON.toJson(value), type);
    }

    @Override
    public void dispose() {
        listeners.clear();
        for (RangeMarker marker : markers.values()) {
            marker.dispose();
        }
        markers.clear();
        documents.clear();
    }
}
