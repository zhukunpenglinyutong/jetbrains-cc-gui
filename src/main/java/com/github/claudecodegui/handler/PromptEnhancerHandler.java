package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.ProcessManager;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.TextEditor;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Prompt enhancement message handler.
 * Calls the AI service to optimize and rewrite the user's prompt.
 *
 * Supports automatic collection of editor context information:
 * - User's selected code snippet
 * - Current open file info (path, content, language type)
 * - Cursor position and surrounding code
 */
public class PromptEnhancerHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PromptEnhancerHandler.class);
    private static final Gson GSON = new Gson();
    private final Gson gson = GSON;
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    // Hard timeout bounds for the enhancement Node.js process. Without a timeout, a
    // network-stalled SDK call would block forever and leak the child process.
    // Short prompts stay snappy; long plain-language requirements get more headroom.
    private static final long ENHANCE_TIMEOUT_BASE_SECONDS = 45;
    private static final long ENHANCE_TIMEOUT_MAX_SECONDS = 120;
    private static final int ENHANCE_TIMEOUT_CHARS_PER_EXTRA_SECOND = 400;
    // Grace window after the process exits, for the async reader thread to drain stdout.
    private static final long READER_DRAIN_SECONDS = 5;

    // Number of context lines to capture before and after the cursor
    private static final int CURSOR_CONTEXT_LINES = 10;

    private static final String[] SUPPORTED_TYPES = {
        "enhance_prompt"
    };

    // System prompt for prompt enhancement
    // Note: Must emphasize "only output the enhanced prompt" to prevent the AI from adding explanatory text
    // Includes guidance on leveraging editor context information
    private static final String ENHANCE_SYSTEM_PROMPT =
        "You are a prompt optimization expert. The user will send a prompt to be optimized in the format:\n" +
        "\"Please optimize the following prompt:\n[Original prompt]\"\n\n" +
        "The user may also provide relevant context information, including:\n" +
        "- [User's Selected Code]: Code snippet selected by the user in the editor\n" +
        "- [Code Around Cursor]: Context around the user's current editing position\n" +
        "- [Current File]: Path of the file the user is editing\n" +
        "- [Language Type]: Programming language of the current file\n" +
        "- [File Content Preview]: Partial content of the current file\n" +
        "- [Related Files]: Other files related to the current file\n" +
        "- [Project Type]: Type of the project (e.g., Java, React, etc.)\n\n" +
        "Your task is to optimize this prompt, making it clearer, more specific, and less ambiguous.\n\n" +
        "[IMPORTANT] Output Rules:\n" +
        "- Output ONLY the optimized prompt itself, with no additional content\n" +
        "- Do NOT add any explanations, prefixes, suffixes, or comments\n" +
        "- Do NOT use prefixes like \"Optimized prompt:\"\n" +
        "- Do NOT use Markdown headings or formatting\n" +
        "- Do NOT ask the user any questions\n" +
        "- Output the prompt text directly, ready to be copied and used\n" +
        "- [KEY] The optimized prompt MUST be in the same language as the user's original prompt. "
        + "If the original is in English, output in English; if in Chinese, output in Chinese; "
        + "if in Japanese, output in Japanese. Always match the language of the original prompt.\n\n" +
        "[How to Utilize Context Information]:\n" +
        "1. If the user's prompt contains vague references (e.g., \"this code\", \"this file\", \"here\"), replace them with specific descriptions based on the context\n" +
        "2. Add relevant professional terminology and best practices based on the code language type\n" +
        "3. Infer the user's possible intent from the selected code content and reflect it in the prompt\n" +
        "4. If file path information is available, reference specific file names or module names in the prompt\n" +
        "5. Do NOT include code snippets directly in the optimized prompt; instead, describe the code's characteristics or location\n\n" +
        "Optimization Principles:\n" +
        "1. Preserve the user's original intent\n" +
        "2. Add necessary context and details\n" +
        "3. Use clear, professional language\n" +
        "4. Correct grammar errors or typos\n" +
        "5. If the original prompt is too vague, add reasonable assumptions and constraints\n" +
        "6. Keep it concise; do not over-expand\n\n" +
        "Example 1 (without context):\n" +
        "User input: Please optimize the following prompt:\\n\\nAnalyze the logic\n" +
        "Your output: Please analyze the business logic of the current code file, including the main functionality, data flow, and key processing steps.\n\n" +
        "Example 2 (with context):\n" +
        "User input: Please optimize the following prompt:\\n\\nWhat's wrong with this code\\n\\n---\\n"
        + "Below is the relevant context information:\\n\\n[User's Selected Code]\\n"
        + "```java\\npublic void process() { ... }\\n```\\n\\n[Current File] UserService.java\\n"
        + "[Language Type] java\n" +
        "Your output: Please analyze the process() method in UserService.java, "
        + "checking for potential issues including but not limited to: null pointer exception risks, "
        + "resource leaks, thread safety concerns, performance bottlenecks, "
        + "and provide improvement suggestions.";

    public PromptEnhancerHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("enhance_prompt".equals(type)) {
            handleEnhancePrompt(content);
            return true;
        }
        return false;
    }

    /**
     * Handle prompt enhancement request.
     * Automatically collects editor context: selectedCode, currentFile, cursorPosition, cursorContext.
     */
    private void handleEnhancePrompt(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject payload = gson.fromJson(content, JsonObject.class);
                String originalPrompt = payload.has("prompt") ? payload.get("prompt").getAsString() : "";
                String legacyModel = payload.has("model") ? payload.get("model").getAsString() : null;
                // Current chat selection — used in auto mode so enhancer follows the chat model.
                String chatProvider = readOptionalString(payload, "chatProvider");
                String chatModel = readOptionalString(payload, "chatModel");

                if (originalPrompt.isEmpty()) {
                    sendEnhanceResult(false, "", "Prompt is empty", true, null);
                    return;
                }

                LOG.info("[PromptEnhancer] Starting prompt enhancement: " + originalPrompt.substring(0, Math.min(50, originalPrompt.length())) + "...");
                if (legacyModel != null) {
                    LOG.info("[PromptEnhancer] Received legacy model from frontend: " + legacyModel);
                }
                if (chatProvider != null || chatModel != null) {
                    LOG.info("[PromptEnhancer] Chat selection: provider="
                            + chatProvider + ", model=" + chatModel);
                }

                // Automatically collect context information from the editor
                JsonObject contextObj = collectEditorContext();

                // Log context information
                if (contextObj != null) {
                    LOG.info("[PromptEnhancer] Editor context collected:");
                    if (contextObj.has("selectedCode")) {
                        String selectedCode = contextObj.get("selectedCode").getAsString();
                        LOG.info("  - Selected code: " + selectedCode.length() + " characters");
                    }
                    if (contextObj.has("currentFile")) {
                        JsonObject currentFile = contextObj.getAsJsonObject("currentFile");
                        if (currentFile.has("path")) {
                            LOG.info("  - Current file: " + currentFile.get("path").getAsString());
                        }
                        if (currentFile.has("language")) {
                            LOG.info("  - Language type: " + currentFile.get("language").getAsString());
                        }
                    }
                    if (contextObj.has("cursorPosition")) {
                        JsonObject cursorPos = contextObj.getAsJsonObject("cursorPosition");
                        if (cursorPos.has("line")) {
                            LOG.info("  - Cursor position: line " + cursorPos.get("line").getAsInt());
                        }
                    }
                    if (contextObj.has("cursorContext")) {
                        String cursorContext = contextObj.get("cursorContext").getAsString();
                        LOG.info("  - Cursor context: " + cursorContext.length() + " characters");
                    }
                } else {
                    LOG.info("[PromptEnhancer] Failed to collect editor context");
                }

                // Auto mode follows the current chat provider when that CLI is available.
                JsonObject promptEnhancerConfig = context.getSettingsService()
                        .getPromptEnhancerConfig(context.getCurrentProvider());
                // Push usage meta immediately so the dialog can show mode/CLI/model
                // while the enhancement is still running.
                JsonObject usageMeta = buildUsageMeta(promptEnhancerConfig, chatProvider, chatModel);
                sendEnhanceResult(true, "", null, false, usageMeta);

                EnhanceOutcome outcome = callAIForEnhancement(
                        originalPrompt, legacyModel, contextObj, promptEnhancerConfig,
                        chatProvider, chatModel);

                if (outcome.success && outcome.text != null && !outcome.text.isEmpty()) {
                    LOG.info("[PromptEnhancer] Enhancement successful"
                            + (outcome.partial ? " (partial)" : ""));
                    // Surface partial-cause (e.g. timeout) so the user knows the
                    // result was truncated instead of silently accepting it.
                    sendEnhanceResult(true, outcome.text,
                            outcome.partial ? outcome.error : null, true, usageMeta);
                } else if (outcome.text != null && !outcome.text.isEmpty()) {
                    // Failed but we already streamed partial text — keep it usable.
                    LOG.warn("[PromptEnhancer] Enhancement incomplete: " + outcome.error);
                    sendEnhanceResult(true, outcome.text, outcome.error, true, usageMeta);
                } else {
                    LOG.warn("[PromptEnhancer] Enhancement failed: "
                            + (outcome.error != null ? outcome.error : "empty result returned"));
                    sendEnhanceResult(false, "",
                            outcome.error != null ? outcome.error : "Enhancement failed: empty result returned",
                            true, usageMeta);
                }

            } catch (Exception e) {
                LOG.error("[PromptEnhancer] Prompt enhancement failed: " + e.getMessage(), e);
                sendEnhanceResult(false, "", "Enhancement failed: " + e.getMessage(), true, null);
            }
        });
    }

    /**
     * Dynamic wall-clock timeout: base + 1s per N chars of the user prompt, capped.
     * Exposed package-private for unit tests.
     */
    static long computeEnhanceTimeoutSeconds(int promptLength) {
        long extra = Math.max(0, promptLength) / (long) ENHANCE_TIMEOUT_CHARS_PER_EXTRA_SECOND;
        return Math.min(ENHANCE_TIMEOUT_MAX_SECONDS, Math.max(ENHANCE_TIMEOUT_BASE_SECONDS,
                ENHANCE_TIMEOUT_BASE_SECONDS + extra));
    }

    /** Result of a single enhance process run. */
    static final class EnhanceOutcome {
        final boolean success;
        final boolean partial;
        final String text;
        final String error;

        EnhanceOutcome(boolean success, boolean partial, String text, String error) {
            this.success = success;
            this.partial = partial;
            this.text = text;
            this.error = error;
        }
    }

    /**
     * Collect context information from the editor.
     * Includes: selected code, current file info, cursor position, and code surrounding the cursor.
     *
     * @return a JsonObject containing context information, or null if unavailable
     */
    private JsonObject collectEditorContext() {
        AtomicReference<JsonObject> contextRef = new AtomicReference<>(null);

        try {
            // Use ReadAction to safely access the editor from the read thread
            ApplicationManager.getApplication().invokeAndWait(() -> {
                ApplicationManager.getApplication().runReadAction(() -> {
                    try {
                        JsonObject contextObj = new JsonObject();
                        boolean hasContext = false;

                        FileEditorManager fileEditorManager = FileEditorManager.getInstance(context.getProject());
                        FileEditor selectedEditor = fileEditorManager.getSelectedEditor();

                        if (selectedEditor instanceof TextEditor) {
                            Editor editor = ((TextEditor) selectedEditor).getEditor();
                            Document document = editor.getDocument();
                            VirtualFile virtualFile = FileDocumentManager.getInstance().getFile(document);

                            if (virtualFile != null) {
                                // 1. Current file information
                                JsonObject currentFile = new JsonObject();
                                currentFile.addProperty("path", virtualFile.getPath());
                                currentFile.addProperty("language", getLanguageFromExtension(virtualFile.getExtension()));
                                contextObj.add("currentFile", currentFile);
                                hasContext = true;

                                // 2. Selected code
                                SelectionModel selectionModel = editor.getSelectionModel();
                                if (selectionModel.hasSelection()) {
                                    String selectedText = selectionModel.getSelectedText();
                                    if (selectedText != null && !selectedText.trim().isEmpty()) {
                                        contextObj.addProperty("selectedCode", selectedText);

                                        // Line number range of selected code
                                        int startLine = document.getLineNumber(selectionModel.getSelectionStart()) + 1;
                                        int endLine = document.getLineNumber(selectionModel.getSelectionEnd()) + 1;

                                        JsonObject selectionRange = new JsonObject();
                                        selectionRange.addProperty("startLine", startLine);
                                        selectionRange.addProperty("endLine", endLine);
                                        contextObj.add("selectionRange", selectionRange);
                                    }
                                }

                                // 3. Cursor position
                                int caretOffset = editor.getCaretModel().getOffset();
                                int caretLine = document.getLineNumber(caretOffset) + 1;
                                int caretColumn = caretOffset - document.getLineStartOffset(caretLine - 1) + 1;

                                JsonObject cursorPosition = new JsonObject();
                                cursorPosition.addProperty("line", caretLine);
                                cursorPosition.addProperty("column", caretColumn);
                                contextObj.add("cursorPosition", cursorPosition);

                                // 4. Code surrounding the cursor (if no code is selected)
                                if (!selectionModel.hasSelection() || selectionModel.getSelectedText() == null || selectionModel.getSelectedText().trim().isEmpty()) {
                                    String cursorContext = getCursorContext(document, caretLine - 1);
                                    if (cursorContext != null && !cursorContext.isEmpty()) {
                                        contextObj.addProperty("cursorContext", cursorContext);
                                    }
                                }
                            }
                        }

                        if (hasContext) {
                            contextRef.set(contextObj);
                        }
                    } catch (Exception e) {
                        LOG.warn("[PromptEnhancer] Failed to get editor context: " + e.getMessage());
                    }
                });
            });
        } catch (Exception e) {
            LOG.warn("[PromptEnhancer] ReadAction invocation failed: " + e.getMessage());
        }

        return contextRef.get();
    }

    /**
     * Get the code context surrounding the cursor.
     *
     * @param document the document object
     * @param caretLine the line where the cursor is located (0-based)
     * @return code snippet surrounding the cursor
     */
    private String getCursorContext(Document document, int caretLine) {
        try {
            int totalLines = document.getLineCount();
            int startLine = Math.max(0, caretLine - CURSOR_CONTEXT_LINES);
            int endLine = Math.min(totalLines - 1, caretLine + CURSOR_CONTEXT_LINES);

            int startOffset = document.getLineStartOffset(startLine);
            int endOffset = document.getLineEndOffset(endLine);

            return document.getText().substring(startOffset, endOffset);
        } catch (Exception e) {
            LOG.warn("[PromptEnhancer] Failed to get cursor context: " + e.getMessage());
            return null;
        }
    }

    /**
     * Get the language type based on file extension.
     *
     * @param extension the file extension
     * @return language type name
     */
    private String getLanguageFromExtension(String extension) {
        if (extension == null) { return "text"; }

        switch (extension.toLowerCase()) {
            case "java": return "java";
            case "kt": case "kts": return "kotlin";
            case "js": case "jsx": return "javascript";
            case "ts": case "tsx": return "typescript";
            case "py": return "python";
            case "go": return "go";
            case "rs": return "rust";
            case "rb": return "ruby";
            case "php": return "php";
            case "c": case "h": return "c";
            case "cpp": case "cc": case "hpp": return "cpp";
            case "cs": return "csharp";
            case "swift": return "swift";
            case "scala": return "scala";
            case "vue": return "vue";
            case "html": case "htm": return "html";
            case "css": return "css";
            case "scss": return "scss";
            case "less": return "less";
            case "json": return "json";
            case "xml": return "xml";
            case "yaml": case "yml": return "yaml";
            case "md": case "markdown": return "markdown";
            case "sql": return "sql";
            case "sh": case "bash": case "zsh": return "bash";
            default: return "text";
        }
    }

    /**
     * Build a compact, redaction-safe description of the prompt enhancer config
     * for logging. Avoids dumping the entire JSON (which may include unrelated
     * availability/resolution metadata).
     */
    private static String describePromptEnhancerConfig(JsonObject promptEnhancerConfig) {
        JsonObject meta = buildUsageMeta(promptEnhancerConfig);
        if (meta == null) {
            return "none";
        }
        String provider = meta.has("provider") && !meta.get("provider").isJsonNull()
                ? meta.get("provider").getAsString()
                : "unresolved";
        String model = meta.has("model") && !meta.get("model").isJsonNull()
                ? meta.get("model").getAsString()
                : "default";
        return provider + ", model: " + model;
    }

    /**
     * Extract the mode / CLI / model actually used for this enhance request so the
     * webview dialog can display them. Package-private for unit tests.
     *
     * @return a JsonObject with {@code provider}, {@code model}, {@code resolutionSource}
     *         (any field may be omitted / null when unresolved)
     */
    static JsonObject buildUsageMeta(JsonObject promptEnhancerConfig) {
        return buildUsageMeta(promptEnhancerConfig, null, null);
    }

    /**
     * Same as {@link #buildUsageMeta(JsonObject)} but, in auto mode, prefers the
     * chat-input model when {@code chatProvider} matches the resolved enhancer provider.
     */
    static JsonObject buildUsageMeta(
            JsonObject promptEnhancerConfig,
            String chatProvider,
            String chatModel
    ) {
        JsonObject meta = new JsonObject();
        if (promptEnhancerConfig == null) {
            meta.addProperty("resolutionSource", "unavailable");
            return meta;
        }

        String resolutionSource = "auto";
        if (promptEnhancerConfig.has("resolutionSource")
                && !promptEnhancerConfig.get("resolutionSource").isJsonNull()) {
            resolutionSource = promptEnhancerConfig.get("resolutionSource").getAsString();
        }
        meta.addProperty("resolutionSource", resolutionSource);

        String provider = null;
        if (promptEnhancerConfig.has("effectiveProvider")
                && !promptEnhancerConfig.get("effectiveProvider").isJsonNull()) {
            provider = promptEnhancerConfig.get("effectiveProvider").getAsString();
        }
        if (provider != null && !provider.isEmpty()) {
            meta.addProperty("provider", provider);
        }

        String model = null;
        if (provider != null
                && promptEnhancerConfig.has("models")
                && promptEnhancerConfig.get("models").isJsonObject()) {
            JsonObject models = promptEnhancerConfig.getAsJsonObject("models");
            if (models.has(provider) && !models.get(provider).isJsonNull()) {
                String configured = models.get(provider).getAsString();
                if (configured != null && !configured.isEmpty()) {
                    model = configured;
                }
            }
        }

        // Auto mode: follow the model currently selected in the chat input when
        // the enhancer resolved to the same provider as the chat session.
        if ("auto".equals(resolutionSource)
                && provider != null
                && chatProvider != null
                && !chatProvider.isBlank()
                && chatModel != null
                && !chatModel.isBlank()
                && provider.trim().equalsIgnoreCase(chatProvider.trim())) {
            model = chatModel.trim();
        }

        if (model != null && !model.isEmpty()) {
            meta.addProperty("model", model);
        }
        return meta;
    }

    private static String readOptionalString(JsonObject payload, String key) {
        if (payload == null || !payload.has(key) || payload.get(key).isJsonNull()) {
            return null;
        }
        try {
            String value = payload.get(key).getAsString();
            if (value == null) {
                return null;
            }
            String trimmed = value.trim();
            return trimmed.isEmpty() ? null : trimmed;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Call the AI service for prompt enhancement.
     * @param originalPrompt the original prompt
     * @param legacyModel the legacy model to use as a fallback (optional)
     * @param contextObj context information (optional)
     * @param promptEnhancerConfig resolved prompt enhancer configuration
     */
    private EnhanceOutcome callAIForEnhancement(
            String originalPrompt,
            String legacyModel,
            JsonObject contextObj,
            JsonObject promptEnhancerConfig,
            String chatProvider,
            String chatModel
    ) {
        LOG.info("[PromptEnhancer] Starting AI service call for prompt enhancement");
        LOG.info("[PromptEnhancer] Original prompt: " + originalPrompt);
        LOG.info("[PromptEnhancer] Using provider: " + describePromptEnhancerConfig(promptEnhancerConfig));

        try {
            // Call AI service using a Node.js script
            String nodeExecutable = context.getClaudeSDKBridge().getNodeExecutable();
            if (nodeExecutable == null) {
                LOG.error("[PromptEnhancer] Node.js is not configured");
                return new EnhanceOutcome(false, false, null, "Node.js is not configured");
            }
            LOG.info("[PromptEnhancer] Node.js path: " + nodeExecutable);

            File bridgeDir = context.getClaudeSDKBridge().getSdkTestDir();
            if (bridgeDir == null || !bridgeDir.exists()) {
                LOG.error("[PromptEnhancer] AI Bridge directory does not exist");
                return new EnhanceOutcome(false, false, null, "AI Bridge directory does not exist");
            }
            LOG.info("[PromptEnhancer] AI Bridge directory: " + bridgeDir.getAbsolutePath());

            // Build the command
            List<String> command = new ArrayList<>();
            command.add(nodeExecutable);
            command.add(new File(bridgeDir, "services/prompt-enhancer.js").getAbsolutePath());
            LOG.info("[PromptEnhancer] Executing command: " + String.join(" ", command));

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            // Merge stderr into stdout so the async reader drains both and the
            // child cannot block on a full stderr pipe. Protocol markers are
            // prefix-matched, so log lines are ignored safely.
            pb.redirectErrorStream(true);

            // Set environment variables
            envConfigurator.updateProcessEnvironment(pb, nodeExecutable);

            // Build stdin payload
            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("prompt", originalPrompt);
            stdinInput.addProperty("systemPrompt", ENHANCE_SYSTEM_PROMPT);
            if (legacyModel != null && !legacyModel.isEmpty()) {
                stdinInput.addProperty("legacyModel", legacyModel);
            }
            if (chatProvider != null && !chatProvider.isEmpty()) {
                stdinInput.addProperty("chatProvider", chatProvider);
            }
            if (chatModel != null && !chatModel.isEmpty()) {
                stdinInput.addProperty("chatModel", chatModel);
            }
            if (contextObj != null) {
                stdinInput.add("context", contextObj);
            }
            if (promptEnhancerConfig != null) {
                stdinInput.add("promptEnhancerConfig", promptEnhancerConfig);
            }

            long timeoutSeconds = computeEnhanceTimeoutSeconds(
                    originalPrompt != null ? originalPrompt.length() : 0);
            LOG.info("[PromptEnhancer] Timeout: " + timeoutSeconds + "s");

            // Delegate to the runner so that:
            //  1. The process is registered with ProcessManager (cleanup on shutdown).
            //  2. A hard timeout actually kills hung Node processes.
            //  3. The process is unregistered + force-killed in finally on every exit path.
            // Streaming: [CONTENT_DELTA] lines are pushed to the webview as they arrive.
            ProcessManager processManager = context.getClaudeSDKBridge().getProcessManager();
            StringBuilder response = new StringBuilder();
            StringBuilder streamed = new StringBuilder();
            StringBuilder errorMessage = new StringBuilder();
            StringBuilder allOutput = new StringBuilder();
            final Object streamLock = new Object();
            final AtomicReference<String> latestPreview = new AtomicReference<>("");
            final AtomicBoolean progressScheduled = new AtomicBoolean(false);
            // Set once the process run ends (success/timeout/failure); late reader
            // output after drain timeout must not overwrite the final result.
            final AtomicBoolean finished = new AtomicBoolean(false);
            final JsonObject usageMeta = buildUsageMeta(promptEnhancerConfig, chatProvider, chatModel);

            try {
                int exitCode = PromptEnhancerProcessRunner.runWithProcessManager(
                        pb,
                        processManager,
                        gson.toJson(stdinInput),
                        timeoutSeconds,
                        READER_DRAIN_SECONDS,
                        line -> {
                            synchronized (streamLock) {
                                allOutput.append(line).append("\n");
                            }
                            LOG.info("[PromptEnhancer] Node.js: " + line);
                            if (line.startsWith("[CONTENT_DELTA]")) {
                                String payload = line.substring("[CONTENT_DELTA]".length()).trim();
                                String delta = parseJsonStringPayload(payload);
                                if (delta != null && !delta.isEmpty()) {
                                    synchronized (streamLock) {
                                        streamed.append(delta);
                                        latestPreview.set(streamed.toString());
                                    }
                                    scheduleEnhanceProgress(latestPreview, progressScheduled, finished, usageMeta);
                                }
                            } else if (line.startsWith("[ENHANCED_ERROR]")) {
                                String err = line.substring("[ENHANCED_ERROR]".length()).trim();
                                if (!err.isEmpty()) {
                                    synchronized (streamLock) {
                                        errorMessage.append(err);
                                    }
                                }
                            } else if (line.startsWith("[ENHANCED]")) {
                                String enhancedText = line.substring("[ENHANCED]".length()).trim();
                                enhancedText = enhancedText.replace("{{NEWLINE}}", "\n");
                                synchronized (streamLock) {
                                    response.append(enhancedText);
                                }
                            }
                        }
                );
                LOG.info("[PromptEnhancer] Node.js process exit code: " + exitCode);

                finished.set(true);
                // Reads must hold streamLock: on drain timeout the reader thread
                // may still be alive and appending to these builders.
                final String finalText;
                final String errorText;
                final String outputSnapshot;
                synchronized (streamLock) {
                    finalText = response.length() > 0
                            ? response.toString()
                            : streamed.toString();
                    errorText = errorMessage.toString();
                    outputSnapshot = allOutput.toString();
                }
                if (errorText.length() > 0) {
                    if (finalText != null && !finalText.isEmpty()) {
                        return new EnhanceOutcome(false, true, finalText, errorText);
                    }
                    return new EnhanceOutcome(false, false, null, errorText);
                }
                if (finalText == null || finalText.isEmpty()) {
                    if (!outputSnapshot.isEmpty()) {
                        LOG.warn("[PromptEnhancer] [ENHANCED] marker not found, full output:\n" + outputSnapshot);
                    }
                    return new EnhanceOutcome(false, false, null, "Enhancement failed: empty result returned");
                }
                return new EnhanceOutcome(true, false, finalText, null);
            } catch (TimeoutException te) {
                LOG.warn("[PromptEnhancer] " + te.getMessage());
                finished.set(true);
                String partial;
                synchronized (streamLock) {
                    partial = streamed.toString();
                }
                if (partial != null && !partial.isEmpty()) {
                    return new EnhanceOutcome(true, true, partial,
                            "Prompt enhancement timed out; showing partial result");
                }
                return new EnhanceOutcome(false, false, null, te.getMessage());
            } finally {
                finished.set(true);
            }

        } catch (Exception e) {
            LOG.error("[PromptEnhancer] AI service call failed: " + e.getMessage(), e);
            return new EnhanceOutcome(false, false, null, e.getMessage());
        }
    }

    /**
     * Parse a stdout delta payload that is a JSON-encoded string (e.g. {@code "Hello"}).
     */
    static String parseJsonStringPayload(String payload) {
        if (payload == null || payload.isEmpty()) {
            return null;
        }
        try {
            return GSON.fromJson(payload, String.class);
        } catch (Throwable t) {
            return payload;
        }
    }

    /**
     * Coalesce EDT progress updates so rapid CONTENT_DELTA lines do not flood JCEF.
     * Updates are dropped once {@code finished} is set so a late delta from a
     * zombie reader cannot revert the dialog to the loading state.
     */
    private void scheduleEnhanceProgress(
            AtomicReference<String> latestPreview,
            AtomicBoolean progressScheduled,
            AtomicBoolean finished,
            JsonObject usageMeta
    ) {
        if (finished.get()) {
            return;
        }
        if (!progressScheduled.compareAndSet(false, true)) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            progressScheduled.set(false);
            if (finished.get()) {
                return;
            }
            String preview = latestPreview.get();
            if (preview != null && !preview.isEmpty()) {
                sendEnhanceResult(true, preview, null, false, usageMeta);
            }
        });
    }

    /**
     * Send the enhancement result (or streaming progress) to the frontend.
     *
     * @param done when false, the UI keeps the loading state and shows partial text
     * @param usageMeta optional provider/model/mode info for the dialog header
     */
    private void sendEnhanceResult(
            boolean success,
            String enhancedPrompt,
            String error,
            boolean done,
            JsonObject usageMeta
    ) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        result.addProperty("enhancedPrompt", enhancedPrompt != null ? enhancedPrompt : "");
        result.addProperty("done", done);
        if (error != null) {
            result.addProperty("error", error);
        }
        if (usageMeta != null) {
            if (usageMeta.has("provider") && !usageMeta.get("provider").isJsonNull()) {
                result.addProperty("provider", usageMeta.get("provider").getAsString());
            }
            if (usageMeta.has("model") && !usageMeta.get("model").isJsonNull()) {
                result.addProperty("model", usageMeta.get("model").getAsString());
            }
            if (usageMeta.has("resolutionSource") && !usageMeta.get("resolutionSource").isJsonNull()) {
                result.addProperty("resolutionSource", usageMeta.get("resolutionSource").getAsString());
            }
        }

        String resultJson = gson.toJson(result);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.updateEnhancedPrompt", escapeJs(resultJson));
        });
    }
}
