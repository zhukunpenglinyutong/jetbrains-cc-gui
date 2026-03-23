package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
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

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
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
    private final Gson gson = new Gson();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

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
        "- [KEY] The optimized prompt MUST be in the same language as the user's original prompt. If the original is in English, output in English; if in Chinese, output in Chinese; if in Japanese, output in Japanese. Always match the language of the original prompt.\n\n" +
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
        "User input: Please optimize the following prompt:\\n\\nWhat's wrong with this code\\n\\n---\\nBelow is the relevant context information:\\n\\n[User's Selected Code]\\n```java\\npublic void process() { ... }\\n```\\n\\n[Current File] UserService.java\\n[Language Type] java\n" +
        "Your output: Please analyze the process() method in UserService.java, checking for potential issues including but not limited to: null pointer exception risks, resource leaks, thread safety concerns, performance bottlenecks, and provide improvement suggestions.";

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
                String model = payload.has("model") ? payload.get("model").getAsString() : null;

                if (originalPrompt.isEmpty()) {
                    sendEnhanceResult(false, "", "Prompt is empty");
                    return;
                }

                LOG.info("[PromptEnhancer] Starting prompt enhancement: " + originalPrompt.substring(0, Math.min(50, originalPrompt.length())) + "...");
                if (model != null) {
                    LOG.info("[PromptEnhancer] Using model: " + model);
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

                // Call AI service for enhancement (passing context information)
                String enhancedPrompt = callAIForEnhancement(originalPrompt, model, contextObj);

                if (enhancedPrompt != null && !enhancedPrompt.isEmpty()) {
                    LOG.info("[PromptEnhancer] Enhancement successful");
                    sendEnhanceResult(true, enhancedPrompt, null);
                } else {
                    LOG.warn("[PromptEnhancer] Enhancement failed: empty result returned");
                    sendEnhanceResult(false, "", "Enhancement failed: empty result returned");
                }

            } catch (Exception e) {
                LOG.error("[PromptEnhancer] Prompt enhancement failed: " + e.getMessage(), e);
                sendEnhanceResult(false, "", "Enhancement failed: " + e.getMessage());
            }
        });
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
        if (extension == null) return "text";

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
     * Call the AI service for prompt enhancement.
     * @param originalPrompt the original prompt
     * @param model the model to use (optional)
     * @param contextObj context information (optional)
     */
    private String callAIForEnhancement(String originalPrompt, String model, JsonObject contextObj) {
        LOG.info("[PromptEnhancer] Starting AI service call for prompt enhancement");
        LOG.info("[PromptEnhancer] Original prompt: " + originalPrompt);
        LOG.info("[PromptEnhancer] Using model: " + (model != null ? model : "default"));

        try {
            // Call AI service using a Node.js script
            String nodeExecutable = context.getClaudeSDKBridge().getNodeExecutable();
            if (nodeExecutable == null) {
                LOG.error("[PromptEnhancer] Node.js is not configured");
                return null;
            }
            LOG.info("[PromptEnhancer] Node.js path: " + nodeExecutable);

            File bridgeDir = context.getClaudeSDKBridge().getSdkTestDir();
            if (bridgeDir == null || !bridgeDir.exists()) {
                LOG.error("[PromptEnhancer] AI Bridge directory does not exist");
                return null;
            }
            LOG.info("[PromptEnhancer] AI Bridge directory: " + bridgeDir.getAbsolutePath());

            // Build the command
            List<String> command = new ArrayList<>();
            command.add(nodeExecutable);
            command.add(new File(bridgeDir, "services/prompt-enhancer.js").getAbsolutePath());
            LOG.info("[PromptEnhancer] Executing command: " + String.join(" ", command));

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);

            // Set environment variables
            envConfigurator.updateProcessEnvironment(pb, nodeExecutable);

            Process process = pb.start();
            LOG.info("[PromptEnhancer] Node.js process started");

            // Send request data to stdin (including context information)
            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("prompt", originalPrompt);
            stdinInput.addProperty("systemPrompt", ENHANCE_SYSTEM_PROMPT);
            if (model != null && !model.isEmpty()) {
                stdinInput.addProperty("model", model);
            }
            // Add context information
            if (contextObj != null) {
                stdinInput.add("context", contextObj);
            }

            try (OutputStreamWriter writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
                writer.write(gson.toJson(stdinInput));
                writer.flush();
            }

            // Read the response
            StringBuilder response = new StringBuilder();
            StringBuilder allOutput = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    allOutput.append(line).append("\n");
                    // Print all output for debugging
                    LOG.info("[PromptEnhancer] Node.js: " + line);
                    if (line.startsWith("[ENHANCED]")) {
                        // Decode the special marker, restore newlines
                        String enhancedText = line.substring("[ENHANCED]".length()).trim();
                        enhancedText = enhancedText.replace("{{NEWLINE}}", "\n");
                        response.append(enhancedText);
                    }
                }
            }

            int exitCode = process.waitFor();
            LOG.info("[PromptEnhancer] Node.js process exit code: " + exitCode);

            if (response.length() == 0 && allOutput.length() > 0) {
                LOG.warn("[PromptEnhancer] [ENHANCED] marker not found, full output:\n" + allOutput);
            }

            return response.toString();

        } catch (Exception e) {
            LOG.error("[PromptEnhancer] AI service call failed: " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * Send the enhancement result to the frontend.
     */
    private void sendEnhanceResult(boolean success, String enhancedPrompt, String error) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        result.addProperty("enhancedPrompt", enhancedPrompt);
        if (error != null) {
            result.addProperty("error", error);
        }

        String resultJson = gson.toJson(result);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.updateEnhancedPrompt", escapeJs(resultJson));
        });
    }
}

