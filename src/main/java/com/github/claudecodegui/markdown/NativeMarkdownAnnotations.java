package com.github.claudecodegui.markdown;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.event.DocumentEvent;
import com.intellij.openapi.editor.event.DocumentListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.util.Computable;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import org.intellij.plugins.markdown.extensions.MarkdownBrowserPreviewExtension;
import org.intellij.plugins.markdown.ui.preview.BrowserPipe;
import org.intellij.plugins.markdown.ui.preview.MarkdownHtmlPanel;
import org.intellij.plugins.markdown.ui.preview.ResourceProvider;
import org.intellij.plugins.markdown.ui.preview.html.MarkdownUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.Set;
import java.util.HashSet;
import java.util.function.Consumer;

/** Narrow extension-specific protocol on the native BrowserPipe. */
public final class NativeMarkdownAnnotations implements MarkdownBrowserPreviewExtension, ResourceProvider {
    private static final String REQUEST = "ccgui.markdown.request";
    private static final String RESPONSE = "ccgui.markdown.response";
    private static final String SCRIPT = "ccgui-markdown-annotations.js";
    private static final String STYLE = "ccgui-markdown-annotations.css";
    private static final Gson GSON = new Gson();
    private static final com.intellij.openapi.diagnostic.Logger LOG =
            com.intellij.openapi.diagnostic.Logger.getInstance(NativeMarkdownAnnotations.class);
    private final Project project;
    private final VirtualFile file;
    private final Document document;
    private final BrowserPipe pipe;
    private final String panelId = UUID.randomUUID().toString();
    private final MarkdownReviewService service;
    private final com.github.claudecodegui.settings.CodemossSettingsService settings = new com.github.claudecodegui.settings.CodemossSettingsService();
    private final BrowserPipe.Handler handler = new BrowserPipe.Handler() {
        @Override
        public boolean processMessageReceived(@NotNull String message) {
            return receive(message);
        }
    };
    private final Consumer<MarkdownReviewService.EditImpact> listener = impact -> publish(false);
    private final Map<String, JsonObject> results = new LinkedHashMap<>();
    private final Set<String> transfers = new HashSet<>();
    private volatile boolean disposed;
    private volatile boolean dirty;
    /** Tracks whether the last published frame said "enabled"; disabled frames are sent once. */
    private volatile boolean lastPublishedEnabled;
    /** One small "behind" frame per dirty episode; the caught-up sync sends the full frame. */
    private volatile boolean dirtyFrameSent;
    /** Shadow copies of the last full/light frames; unchanged panels stay silent (plan §1d). */
    private String lastFullBase;
    private String lastLightPayload;
    private final DocumentListener documentListener = new DocumentListener() {
        @Override
        public void documentChanged(@NotNull DocumentEvent event) {
            // The preview's sync request after the next IDE render patch drives the refresh;
            // the panel only tracks staleness here for annotation-creation gating.
            dirty = true;
        }
    };

    public NativeMarkdownAnnotations(MarkdownHtmlPanel panel) {
        project = panel.getProject();
        file = panel.getVirtualFile();
        pipe = panel.getBrowserPipe();
        document = ApplicationManager.getApplication().runReadAction((Computable<Document>) () -> FileDocumentManager.getInstance().getDocument(file));
        service = MarkdownReviewService.getInstance(project);
        pipe.subscribe(REQUEST, handler);
        service.subscribe(listener);
        if (document != null) {
            // The service owns the disposable; the deprecated no-parent overload leaks listeners.
            document.addDocumentListener(documentListener, service);
        }
    }

    @Override
    public @NotNull List<String> getScripts() {
        return List.of(SCRIPT);
    }

    @Override
    public @NotNull List<String> getStyles() {
        return List.of(STYLE);
    }

    @Override
    public @NotNull ResourceProvider getResourceProvider() {
        return this;
    }

    @Override
    public boolean canProvide(@NotNull String resourceName) {
        return SCRIPT.equals(resourceName) || STYLE.equals(resourceName);
    }

    @Override
    public @Nullable Resource loadResource(@NotNull String resourceName) {
        if (!canProvide(resourceName)) {
            return null;
        }
        String mime = SCRIPT.equals(resourceName) ? "application/javascript; charset=utf-8" : "text/css; charset=utf-8";
        return ResourceProvider.loadInternalResource(getClass(), "/markdown-annotations/" + resourceName, mime);
    }

    private boolean receive(String raw) {
        if (disposed || project.isDisposed() || document == null || !file.isValid()) {
            return true;
        }
        if (raw.length() > MarkdownReviewLimits.REQUEST_MAX_CHARS) {
            // Reply only on a trustworthy id; either way the drop is logged so it
            // can be reconciled instead of surfacing as an unexplained timeout.
            reject(extractRequestId(raw), "requestTooLarge", "request exceeded " + raw.length() + " chars");
            return true;
        }
        JsonObject request;
        try {
            request = GSON.fromJson(raw, JsonObject.class);
        } catch (RuntimeException error) {
            reject(null, "badRequest", "malformed JSON: " + error.getMessage() + " | " + sample(raw));
            return true;
        }
        if (request == null || !hasString(request, "action") || !hasString(request, "requestId")) {
            reject(null, "badRequest", "missing action/requestId | " + sample(raw));
            return true;
        }
        String requestId = request.get("requestId").getAsString();
        if (requestId.length() > MarkdownReviewLimits.REQUEST_ID_MAX_CHARS) {
            // An oversized id cannot be echoed back safely; log only.
            reject(null, "badRequest", "requestId exceeded " + requestId.length() + " chars");
            return true;
        }
        ApplicationManager.getApplication().invokeLater(() -> handle(request), ModalityState.nonModal());
        return true;
    }

    private static boolean hasString(JsonObject request, String field) {
        return request.has(field) && request.get(field).isJsonPrimitive()
                && request.get(field).getAsJsonPrimitive().isString();
    }

    /** Best-effort id recovery for payloads too large to parse; null when untrustworthy. */
    private static String extractRequestId(String raw) {
        java.util.regex.Matcher match = java.util.regex.Pattern
                .compile("\"requestId\"\\s*:\\s*\"([A-Za-z0-9._-]{1," + MarkdownReviewLimits.REQUEST_ID_MAX_CHARS + "})\"")
                .matcher(raw);
        return match.find() ? match.group(1) : null;
    }

    private static String sample(String raw) {
        return raw.length() <= 120 ? raw : raw.substring(0, 120) + "…";
    }

    /** A rejected bridge request must never vanish: log it, and answer when it can be correlated. */
    private void reject(@Nullable String requestId, String messageKey, String reason) {
        LOG.warn("Dropped Markdown review bridge request: " + reason);
        if (requestId == null) {
            return;
        }
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        response.addProperty("status", "error");
        response.addProperty("messageKey", messageKey);
        reply(response);
    }

    private void handle(JsonObject request) {
        if (disposed || project.isDisposed() || !file.isValid()) {
            return;
        }
        String requestId = request.get("requestId").getAsString();
        JsonObject cached = results.get(requestId);
        if (cached != null) {
            reply(cached);
            return;
        }
        if (transfers.contains(requestId)) {
            // The same intent is still running (e.g. the chat chooser is open);
            // tell the retry instead of leaving it on the fixed timeout.
            replyProcessing(requestId);
            return;
        }
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        try {
            String action = request.get("action").getAsString();
            if ("ready".equals(action) || "sync".equals(action)) {
                if (!service.getConfig().enabled) {
                    // R2: closed means no per-keystroke work at all.
                    response.addProperty("status", "ok");
                    remember(requestId, response);
                    reply(response);
                    return;
                }
                // The native root maps 0..Document.length (verified on 243).
                // A delayed patch for an earlier document must not re-enable
                // annotation creation for stale source offsets.
                dirty = !request.has("renderedSourceLength") || request.get("renderedSourceLength").getAsLong() != document.getTextLength();
                if ("ready".equals(action)) {
                    // R7: a fresh page must always receive a frame, even when the
                    // payload is identical to the previous page's.
                    lastFullBase = null;
                    lastLightPayload = null;
                    dirtyFrameSent = false;
                }
                if (dirty) {
                    // R1: while the native preview is still behind the document,
                    // answer only with the "behind" state; the next caught-up sync
                    // performs the single full refresh.
                    response.addProperty("status", "ok");
                    remember(requestId, response);
                    reply(response);
                    publishBehindState();
                    return;
                }
                dirtyFrameSent = false;
                ApplicationManager.getApplication().runReadAction((Computable<Object>) () -> {
                    service.reconcile(file, document);
                    return null;
                });
                response.addProperty("status", "ok");
            } else {
                if (!service.getConfig().enabled) {
                    throw new ReviewRequestException("disabled", "Markdown annotations are disabled in CC GUI settings.");
                }
                if (!request.has("panelId") || !panelId.equals(request.get("panelId").getAsString())) {
                    throw new ReviewRequestException("panelChanged", "Preview changed. Select the text again.");
                }
                switch (action) {
                    case "anchor":
                        if (dirty || request.get("documentVersion").getAsLong() != document.getModificationStamp()) {
                            throw new ReviewRequestException("documentChanged", "Document changed. Wait for the preview and select the text again.");
                        }
                        String anchorText = request.get("selectedText").getAsString();
                        int anchorStart = request.get("start").getAsInt();
                        int anchorEnd = request.get("end").getAsInt();
                        if (anchorText.length() > MarkdownReviewLimits.TEXT_MAX_CHARS
                                || anchorStart < 0 || anchorEnd > document.getTextLength() || anchorEnd <= anchorStart) {
                            throw new ReviewRequestException("selectionInvalid", "Selection or comment is too large or invalid.");
                        }
                        if (!document.getText().substring(anchorStart, anchorEnd).contains(anchorText)
                                && !RenderedSelectionMatcher.matchesMermaidSource(document.getText().substring(anchorStart, anchorEnd), anchorText)
                                && !matchesRenderedSelection(request, anchorStart, anchorEnd, anchorText)) {
                            throw new ReviewRequestException("selectionMismatch", "This selection cannot be matched to the source. Select a smaller text fragment.");
                        }
                        Annotation anchored = ApplicationManager.getApplication().runReadAction((Computable<Annotation>) () ->
                                service.reanchor(file, request.get("id").getAsString(), request.get("revision").getAsLong(),
                                        document, anchorStart, anchorEnd, anchorText));
                        if (service.getConfig().autoAddToChat && MarkdownReviewService.isTransferable(anchored)) {
                            transfer(requestId, List.of(anchored), "review", true);
                            publish();
                            return;
                        }
                        break;
                    case "create":
                    case "quote":
                        if (dirty || request.get("documentVersion").getAsLong() != document.getModificationStamp()) {
                            throw new ReviewRequestException("documentChanged", "Document changed. Wait for the preview and select the text again.");
                        }
                        String selected = request.get("selectedText").getAsString();
                        String comment = request.has("comment") ? request.get("comment").getAsString() : "";
                        int start = request.get("start").getAsInt();
                        int end = request.get("end").getAsInt();
                        if (selected.length() > MarkdownReviewLimits.TEXT_MAX_CHARS
                                || comment.length() > MarkdownReviewLimits.TEXT_MAX_CHARS
                                || start < 0 || end > document.getTextLength() || end <= start) {
                            throw new ReviewRequestException("selectionInvalid", "Selection or comment is too large or invalid.");
                        }
                        if (!document.getText().substring(start, end).contains(selected)
                                && !RenderedSelectionMatcher.matchesMermaidSource(document.getText().substring(start, end), selected)
                                && !matchesRenderedSelection(request, start, end, selected)) {
                            throw new ReviewRequestException("selectionMismatch", "This selection cannot be matched to the source. Select a smaller text fragment.");
                        }
                        if ("quote".equals(action)) {
                            Annotation quotation = ApplicationManager.getApplication().runReadAction((Computable<Annotation>) () ->
                                    service.snapshot(file, relativePath(), document, start, end, selected, ""));
                            transfer(requestId, List.of(quotation), "quote");
                            return;
                        }
                        Annotation created = ApplicationManager.getApplication().runReadAction((Computable<Annotation>) () ->
                                service.create(file, relativePath(), document, start, end, selected, comment));
                        if (service.getConfig().autoAddToChat) {
                            transfer(requestId, List.of(created), "review", true);
                            publish();
                            return;
                        }
                        break;
                    case "update":
                    case "delete":
                        service.update(file, request.get("id").getAsString(), request.get("revision").getAsLong(),
                                request.has("comment") ? request.get("comment").getAsString() : "", "delete".equals(action));
                        if ("update".equals(action) && service.getConfig().autoAddToChat) {
                            Annotation updated = service.list(file).stream()
                                    .filter(item -> item.id.equals(request.get("id").getAsString())).findFirst().orElse(null);
                            if (updated == null) {
                                throw new ReviewRequestException("stale", "Comment is no longer available.");
                            }
                            if (MarkdownReviewService.isTransferable(updated)) {
                                transfer(requestId, List.of(updated), "review", true);
                                publish();
                                return;
                            }
                        }
                        break;
                    case "navigate":
                        Annotation annotation = service.list(file).stream()
                                .filter(item -> item.id.equals(request.get("id").getAsString())).findFirst().orElse(null);
                        if (annotation == null) {
                            throw new ReviewRequestException("missing", "Comment no longer exists.");
                        }
                        if (!MarkdownReviewService.isLocatable(annotation)) {
                            throw new ReviewRequestException("stale", "Original text is no longer uniquely located.");
                        }
                        new OpenFileDescriptor(project, file, annotation.start).navigate(true);
                        break;
                    case "complete":
                        service.complete(file, request.get("id").getAsString(), request.get("revision").getAsLong(),
                                request.get("completed").getAsBoolean());
                        break;
                    case "transfer":
                        ApplicationManager.getApplication().runReadAction((Computable<Object>) () -> {
                            service.reconcile(file, document);
                            return null;
                        });
                        List<Annotation> selectedAnnotations = service.list(file).stream()
                                .filter(MarkdownReviewService::isTransferable).toList();
                        if (request.has("annotationIds")) {
                            List<Annotation> available = selectedAnnotations;
                            List<String> ids = GSON.fromJson(request.get("annotationIds"),
                                    new com.google.gson.reflect.TypeToken<List<String>>() {}.getType());
                            if (ids == null || ids.size() > MarkdownReviewLimits.TRANSFER_IDS_MAX
                                    || ids.stream().anyMatch(id -> available.stream().noneMatch(item -> item.id.equals(id)))) {
                                throw new ReviewRequestException("selectionMissing", "One of the selected comments no longer exists.");
                            }
                            selectedAnnotations = available.stream().filter(item -> ids.contains(item.id)).toList();
                        }
                        transfer(requestId, selectedAnnotations, "review");
                        return;
                    default:
                        throw new ReviewRequestException("unsupported", "Unsupported review action");
                }
                response.addProperty("status", "ok");
            }
        } catch (RuntimeException error) {
            response.addProperty("status", "error");
            // Errors cross layers as keys; the overlay owns the display language
            // (plan §7), so the backend never emits display text.
            if (error instanceof ReviewRequestException keyed) {
                response.addProperty("messageKey", keyed.messageKey);
            } else {
                response.addProperty("messageKey", "failed");
                LOG.warn("Markdown review request failed", error);
            }
        }
        remember(requestId, response);
        reply(response);
        publish();
    }

    private boolean matchesRenderedSelection(JsonObject request, int start, int end, String selected) {
        String attribute = request.has("positionAttribute") ? request.get("positionAttribute").getAsString() : "";
        if (!attribute.matches("[a-zA-Z0-9_-]+") || document.getTextLength() > MarkdownReviewLimits.DOC_MAX_CHARS) {
            return false;
        }
        // Ask the IDE's own generator to validate formatted visible text. This
        // does not replace or modify the IDE-owned browser/renderer.
        String html = ApplicationManager.getApplication().runReadAction((Computable<String>) () -> MarkdownUtil.INSTANCE.generateMarkdownHtml(file, document.getText(), project));
        return RenderedSelectionMatcher.matches(html, attribute, start, end, selected);
    }

    private void transfer(String requestId, List<Annotation> annotations, String kind) {
        transfer(requestId, annotations, kind, false);
    }

    private void transfer(String requestId, List<Annotation> annotations, String kind, boolean automatic) {
        transfers.add(requestId);
        // Manual transfers may park on the modal chat chooser; acknowledge the
        // interactive step so the overlay stops counting down its fixed bound.
        if (!automatic) {
            replyProcessing(requestId);
        }
        ReviewBatch snapshot = new ReviewBatch();
        snapshot.id = UUID.randomUUID().toString();
        snapshot.kind = kind;
        snapshot.automatic = automatic;
        snapshot.autoDeleteAffected = service.getConfig().autoDeleteAffected;
        snapshot.path = relativePath();
        snapshot.documentVersion = document.getModificationStamp();
        snapshot.documentHash = hash(document.getText());
        snapshot.annotations = annotations;
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            failTransfer(requestId, "chatUnavailable", "CC GUI tool window is unavailable.", automatic);
            return;
        }
        toolWindow.show(() -> {
            if (disposed || project.isDisposed()) {
                return;
            }
            if (!service.getConfig().enabled) {
                failTransfer(requestId, "disabled", "Markdown annotations were disabled before the transfer completed.", automatic);
                return;
            }
            List<ClaudeChatWindow> windows = ClaudeSDKToolWindow.getChatWindows(project);
            if (windows.isEmpty()) {
                failTransfer(requestId, "chatStarting", "CC GUI is starting. Wait for the chat input, then try again.", automatic);
                return;
            }
            ClaudeChatWindow selected = ClaudeSDKToolWindow.getSelectedChatWindow(project);
            if (!automatic && windows.size() > 1) {
                String[] labels = windows.stream().map(window -> window.getParentContent().getDisplayName()).toArray(String[]::new);
                // No non-deprecated chooser overload exists; keep the project-parented
                // dialog and track the warning as tech debt (R9).
                int index = Messages.showChooseDialog(project, "Choose the chat for this Markdown review", "CC GUI Markdown Review",
                        null, labels, selected == null ? labels[0] : selected.getParentContent().getDisplayName());
                if (index < 0) {
                    failTransfer(requestId, "chatNotSelected", "Review remains saved. No chat was selected.", false);
                    return;
                }
                selected = windows.get(index);
            }
            if (selected == null || selected.isDisposed() || selected.getSession() == null) {
                failTransfer(requestId, "chatGone", "Target chat is no longer available.", automatic);
                return;
            }
            try {
                ReviewBatch batch = snapshot;
                if (batch.annotations.isEmpty()) {
                    throw new ReviewRequestException("empty", "Add at least one comment first.");
                }
                batch.targetId = selected.getReviewTargetId();
                batch.targetEpoch = selected.getSession().getRuntimeSessionEpoch();
                batch.targetSessionId = selected.getSession().getSessionId();
                if (GSON.toJson(batch).length() > MarkdownReviewLimits.BATCH_MAX_CHARS) {
                    throw new ReviewRequestException("transferTooLarge", "Review is too large. Add comments individually from their popup, or reduce the context before sending.");
                }
                batch = service.saveBatch(batch);
                selected.addArtifactReview(batch);
                JsonObject response = new JsonObject();
                response.addProperty("requestId", requestId);
                response.addProperty("status", "ok");
                response.addProperty("messageKey", "reviewAdded");
                remember(requestId, response);
                reply(response);
            } catch (RuntimeException error) {
                failTransfer(requestId,
                        error instanceof ReviewRequestException keyed ? keyed.messageKey : "failed",
                        error.getMessage(), automatic);
            }
        });
    }

    private void failTransfer(String requestId, String reasonKey, String detail, boolean automatic) {
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        // A failed automatic handoff must not make the editor retry creation:
        // the comment has already been saved by the native service.
        response.addProperty("status", automatic ? "ok" : "error");
        response.addProperty("messageKey", automatic ? "reviewSavedNotAdded" : "reviewNotAdded");
        response.addProperty("reasonKey", reasonKey);
        remember(requestId, response);
        reply(response);
        LOG.warn("Markdown review transfer failed (" + reasonKey + "): " + detail);
    }

    private void remember(String id, JsonObject response) {
        transfers.remove(id);
        results.put(id, response);
        if (results.size() > MarkdownReviewLimits.RESPONSE_CACHE) {
            results.remove(results.keySet().iterator().next());
        }
    }

    private String relativePath() {
        String base = project.getBasePath();
        return base != null && file.getPath().startsWith(base + "/") ? file.getPath().substring(base.length() + 1) : file.getPath();
    }

    private static String hash(String text) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private void publish() {
        publish(false);
    }

    /**
     * @param light position-only refresh (the edit shifted annotations but touched none of
     *              them): skips the full-document Mermaid rescan; the overlay blocks
     *              annotation creation while the document is dirty anyway.
     */
    private void publish(boolean light) {
        if (disposed || document == null || project.isDisposed()) {
            return;
        }
        if (!service.getConfig().enabled) {
            if (lastPublishedEnabled) {
                lastPublishedEnabled = false;
                publishDisabledState();
            }
            return;
        }
        lastPublishedEnabled = true;
        dirtyFrameSent = false;
        ApplicationManager.getApplication().runReadAction((Computable<Object>) () -> {
            JsonObject state = baseState();
            String payload = GSON.toJson(state);
            // Shadow copy (plan §1d): a panel whose state did not change stays
            // silent, so an edit in one file cannot fan a refresh into every
            // open preview — and an untouched panel skips the Mermaid rescan.
            if (light) {
                if (payload.equals(lastLightPayload) || payload.equals(lastFullBase)) {
                    return null;
                }
                lastLightPayload = payload;
                reply(state);
                return null;
            }
            if (payload.equals(lastFullBase)) {
                return null;
            }
            lastFullBase = payload;
            lastLightPayload = null;
            state.add("diagrams", GSON.toJsonTree(RenderedSelectionMatcher.mermaidRanges(document.getText())));
            reply(state);
            return null;
        });
    }

    private JsonObject baseState() {
        JsonObject state = new JsonObject();
        state.addProperty("kind", "state");
        state.addProperty("panelId", panelId);
        state.addProperty("documentVersion", document.getModificationStamp());
        state.addProperty("dirty", dirty);
        state.addProperty("enabled", true);
        state.addProperty("submitShortcut", service.getConfig().submitShortcut);
        state.addProperty("language", com.github.claudecodegui.util.LanguageConfigService.getCurrentLanguage(settings));
        state.addProperty("path", relativePath());
        state.add("annotations", GSON.toJsonTree(service.list(file)));
        return state;
    }

    /** One final frame while disabled so open overlays hide immediately; later calls are no-ops. */
    private void publishDisabledState() {
        // Re-enabling must publish a fresh frame, so the shadow copies reset here.
        lastFullBase = null;
        lastLightPayload = null;
        dirtyFrameSent = false;
        ApplicationManager.getApplication().runReadAction((Computable<Object>) () -> {
            JsonObject state = new JsonObject();
            state.addProperty("kind", "state");
            state.addProperty("panelId", panelId);
            state.addProperty("documentVersion", document.getModificationStamp());
            state.addProperty("dirty", dirty);
            state.addProperty("enabled", false);
            state.addProperty("submitShortcut", service.getConfig().submitShortcut);
            state.addProperty("language", com.github.claudecodegui.util.LanguageConfigService.getCurrentLanguage(settings));
            state.addProperty("path", relativePath());
            reply(state);
            return null;
        });
    }

    /** One small "behind" frame per dirty episode: the overlay hides details while the preview is behind. */
    private void publishBehindState() {
        if (dirtyFrameSent || disposed || document == null || project.isDisposed()) {
            return;
        }
        dirtyFrameSent = true;
        ApplicationManager.getApplication().runReadAction((Computable<Object>) () -> {
            JsonObject state = new JsonObject();
            state.addProperty("kind", "state");
            state.addProperty("panelId", panelId);
            state.addProperty("documentVersion", document.getModificationStamp());
            state.addProperty("dirty", true);
            state.addProperty("enabled", true);
            state.addProperty("submitShortcut", service.getConfig().submitShortcut);
            state.addProperty("language", com.github.claudecodegui.util.LanguageConfigService.getCurrentLanguage(settings));
            state.addProperty("path", relativePath());
            reply(state);
            return null;
        });
    }

    /** Tells the overlay an interactive step (the chat chooser) is still running. */
    private void replyProcessing(String requestId) {
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        response.addProperty("status", "processing");
        response.addProperty("messageKey", "processing");
        reply(response);
    }

    private void reply(JsonObject response) {
        if (!disposed && !project.isDisposed()) {
            pipe.send(RESPONSE, GSON.toJson(response));
        }
    }

    @Override
    public void dispose() {
        disposed = true;
        pipe.removeSubscription(REQUEST, handler);
        service.unsubscribe(listener);
        if (document != null) {
            document.removeDocumentListener(documentListener);
        }
        results.clear();
        transfers.clear();
    }
}
