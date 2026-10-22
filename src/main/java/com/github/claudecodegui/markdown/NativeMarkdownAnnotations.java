package com.github.claudecodegui.markdown;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
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

/** Narrow extension-specific protocol on the native BrowserPipe. */
public final class NativeMarkdownAnnotations implements MarkdownBrowserPreviewExtension, ResourceProvider {
    private static final String REQUEST = "ccgui.markdown.request";
    private static final String RESPONSE = "ccgui.markdown.response";
    private static final String SCRIPT = "ccgui-markdown-annotations.js";
    private static final String STYLE = "ccgui-markdown-annotations.css";
    private static final Gson GSON = new Gson();
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
    private final Runnable listener = this::publish;
    private final Map<String, JsonObject> results = new LinkedHashMap<>();
    private final Set<String> transfers = new HashSet<>();
    private volatile boolean disposed;
    private volatile boolean dirty;
    private final DocumentListener documentListener = new DocumentListener() {
        @Override
        public void documentChanged(@NotNull DocumentEvent event) {
            dirty = true;
            publish();
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
            document.addDocumentListener(documentListener);
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
        if (disposed || project.isDisposed() || document == null || !file.isValid() || raw.length() > 256_000) {
            return true;
        }
        JsonObject request;
        try {
            request = GSON.fromJson(raw, JsonObject.class);
        } catch (RuntimeException error) {
            return true;
        }
        if (request == null || !request.has("action") || !request.has("requestId")
                || !request.get("action").isJsonPrimitive() || !request.get("action").getAsJsonPrimitive().isString()
                || !request.get("requestId").isJsonPrimitive() || !request.get("requestId").getAsJsonPrimitive().isString()
                || request.get("requestId").getAsString().length() > 128) {
            return true;
        }
        ApplicationManager.getApplication().invokeLater(() -> handle(request), ModalityState.nonModal());
        return true;
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
            return;
        }
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        try {
            String action = request.get("action").getAsString();
            if ("ready".equals(action) || "sync".equals(action)) {
                // The native root maps 0..Document.length (verified on 243).
                // A delayed patch for an earlier document must not re-enable
                // annotation creation for stale source offsets.
                dirty = !request.has("renderedSourceLength") || request.get("renderedSourceLength").getAsLong() != document.getTextLength();
                ReadAction.run(() -> service.reconcile(file, document));
                response.addProperty("status", "ok");
            } else {
                if (!service.getConfig().enabled) {
                    throw new IllegalStateException("Markdown annotations are disabled in CC GUI settings.");
                }
                if (!request.has("panelId") || !panelId.equals(request.get("panelId").getAsString())) {
                    throw new IllegalStateException("Preview changed. Select the text again.");
                }
                switch (action) {
                    case "create":
                    case "quote":
                        if (dirty || request.get("documentVersion").getAsLong() != document.getModificationStamp()) {
                            throw new IllegalStateException("Document changed. Wait for the preview and select the text again.");
                        }
                        String selected = request.get("selectedText").getAsString();
                        String comment = request.has("comment") ? request.get("comment").getAsString() : "";
                        int start = request.get("start").getAsInt();
                        int end = request.get("end").getAsInt();
                        if (selected.length() > 32_000 || comment.length() > 32_000 || start < 0 || end > document.getTextLength() || end <= start) {
                            throw new IllegalArgumentException("Selection or comment is too large or invalid.");
                        }
                        if (!document.getText().substring(start, end).contains(selected)
                                && !RenderedSelectionMatcher.matchesMermaidSource(document.getText().substring(start, end), selected)
                                && !matchesRenderedSelection(request, start, end, selected)) {
                            response.addProperty("messageKey", "selectionMismatch");
                            throw new IllegalStateException("This selection cannot be matched to the source. Select a smaller text fragment.");
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
                                    .filter(item -> item.id.equals(request.get("id").getAsString())).findFirst().orElseThrow();
                            if (!updated.completed) {
                                transfer(requestId, List.of(updated), "review", true);
                                publish();
                                return;
                            }
                        }
                        break;
                    case "navigate":
                        Annotation annotation = service.list(file).stream()
                                .filter(item -> item.id.equals(request.get("id").getAsString())).findFirst().orElseThrow();
                        if (!"attached".equals(annotation.status)) {
                            throw new IllegalStateException("Original text is no longer uniquely located.");
                        }
                        new OpenFileDescriptor(project, file, annotation.start).navigate(true);
                        break;
                    case "complete":
                        service.complete(file, request.get("id").getAsString(), request.get("revision").getAsLong(),
                                request.get("completed").getAsBoolean());
                        break;
                    case "transfer":
                        ReadAction.run(() -> service.reconcile(file, document));
                        List<Annotation> selectedAnnotations = service.list(file).stream().filter(item -> !item.completed).toList();
                        if (request.has("annotationIds")) {
                            List<Annotation> available = selectedAnnotations;
                            List<String> ids = GSON.fromJson(request.get("annotationIds"),
                                    new com.google.gson.reflect.TypeToken<List<String>>() {}.getType());
                            if (ids == null || ids.size() > 1000 || ids.stream().anyMatch(id -> available.stream().noneMatch(item -> item.id.equals(id)))) {
                                throw new IllegalArgumentException("One of the selected comments no longer exists.");
                            }
                            selectedAnnotations = available.stream().filter(item -> ids.contains(item.id)).toList();
                        }
                        transfer(requestId, selectedAnnotations, "review");
                        return;
                    default:
                        throw new IllegalArgumentException("Unsupported review action");
                }
                response.addProperty("status", "ok");
            }
        } catch (RuntimeException error) {
            response.addProperty("status", "error");
            response.addProperty("message", error.getMessage() == null ? "Review operation failed" : error.getMessage());
        }
        remember(requestId, response);
        reply(response);
        publish();
    }

    private boolean matchesRenderedSelection(JsonObject request, int start, int end, String selected) {
        String attribute = request.has("positionAttribute") ? request.get("positionAttribute").getAsString() : "";
        if (!attribute.matches("[a-zA-Z0-9_-]+") || document.getTextLength() > 500_000) {
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
            failTransfer(requestId, "CC GUI tool window is unavailable.", automatic);
            return;
        }
        toolWindow.show(() -> {
            if (disposed || project.isDisposed()) {
                return;
            }
            if (!service.getConfig().enabled) {
                failTransfer(requestId, "Markdown annotations were disabled before the transfer completed.", automatic);
                return;
            }
            List<ClaudeChatWindow> windows = ClaudeSDKToolWindow.getChatWindows(project);
            if (windows.isEmpty()) {
                failTransfer(requestId, "CC GUI is starting. Wait for the chat input, then try again.", automatic);
                return;
            }
            ClaudeChatWindow selected = ClaudeSDKToolWindow.getSelectedChatWindow(project);
            if (!automatic && windows.size() > 1) {
                String[] labels = windows.stream().map(window -> window.getParentContent().getDisplayName()).toArray(String[]::new);
                int index = Messages.showChooseDialog(project, "Choose the chat for this Markdown review", "CC GUI Markdown Review",
                        null, labels, selected == null ? labels[0] : selected.getParentContent().getDisplayName());
                if (index < 0) {
                    failTransfer(requestId, "Review remains saved. No chat was selected.", false);
                    return;
                }
                selected = windows.get(index);
            }
            if (selected == null || selected.isDisposed() || selected.getSession() == null) {
                failTransfer(requestId, "Target chat is no longer available.", automatic);
                return;
            }
            try {
                ReviewBatch batch = snapshot;
                if (batch.annotations.isEmpty()) {
                    throw new IllegalStateException("Add at least one comment first.");
                }
                batch.targetId = selected.getReviewTargetId();
                batch.targetEpoch = selected.getSession().getRuntimeSessionEpoch();
                batch.targetSessionId = selected.getSession().getSessionId();
                if (GSON.toJson(batch).length() > 200_000) {
                    throw new IllegalStateException("Review is too large. Add comments individually from their popup, or reduce the context before sending.");
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
                failTransfer(requestId, error.getMessage(), automatic);
            }
        });
    }

    private void failTransfer(String requestId, String message, boolean automatic) {
        JsonObject response = new JsonObject();
        response.addProperty("requestId", requestId);
        // A failed automatic handoff must not make the editor retry creation:
        // the comment has already been saved by the native service.
        response.addProperty("status", automatic ? "ok" : "error");
        response.addProperty("messageKey", automatic ? "reviewSavedNotAdded" : "reviewNotAdded");
        response.addProperty("detail", message);
        remember(requestId, response);
        reply(response);
    }

    private void remember(String id, JsonObject response) {
        transfers.remove(id);
        results.put(id, response);
        if (results.size() > 128) {
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
        if (disposed || document == null || project.isDisposed()) {
            return;
        }
        ReadAction.run(() -> {
            JsonObject state = new JsonObject();
            state.addProperty("kind", "state");
            state.addProperty("panelId", panelId);
            state.addProperty("documentVersion", document.getModificationStamp());
            state.addProperty("dirty", dirty);
            state.addProperty("enabled", service.getConfig().enabled);
            state.addProperty("submitShortcut", service.getConfig().submitShortcut);
            state.addProperty("language", com.github.claudecodegui.util.LanguageConfigService.getCurrentLanguage(settings));
            state.addProperty("path", relativePath());
            state.add("annotations", GSON.toJsonTree(service.list(file)));
            state.add("diagrams", GSON.toJsonTree(RenderedSelectionMatcher.mermaidRanges(document.getText())));
            reply(state);
        });
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
