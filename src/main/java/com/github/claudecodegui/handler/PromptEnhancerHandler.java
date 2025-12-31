package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
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
 * 增强提示词消息处理器
 * 调用 AI 服务对用户的提示词进行优化重写
 *
 * 支持自动获取编辑器上下文信息：
 * - 用户选中的代码片段
 * - 当前打开的文件信息（路径、内容、语言类型）
 * - 光标位置及周围代码
 */
public class PromptEnhancerHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PromptEnhancerHandler.class);
    private final Gson gson = new Gson();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    // 光标上下文的行数范围（光标前后各取多少行）
    private static final int CURSOR_CONTEXT_LINES = 10;

    private static final String[] SUPPORTED_TYPES = {
        "enhance_prompt"
    };

    // 增强提示词的系统提示
    // 注意：必须强调"只输出优化后的提示词"，否则 AI 可能会添加解释性文字
    // 更新：添加了如何利用上下文信息的指导
    private static final String ENHANCE_SYSTEM_PROMPT =
        "你是一个提示词优化专家。用户会发送一个需要优化的提示词，格式为：\n" +
        "\"请优化以下提示词：\n[原始提示词]\"\n\n" +
        "用户可能还会提供相关的上下文信息，包括：\n" +
        "- 【用户选中的代码】：用户在编辑器中选中的代码片段\n" +
        "- 【光标位置周围的代码】：用户当前编辑位置的上下文\n" +
        "- 【当前文件】：用户正在编辑的文件路径\n" +
        "- 【语言类型】：当前文件的编程语言\n" +
        "- 【文件内容预览】：当前文件的部分内容\n" +
        "- 【相关文件】：与当前文件相关的其他文件\n" +
        "- 【项目类型】：项目的类型（如 Java、React 等）\n\n" +
        "你的任务是优化这个提示词，使其更清晰、更具体、减少歧义性。\n\n" +
        "【重要】输出规则：\n" +
        "- 只输出优化后的提示词本身，不要有任何其他内容\n" +
        "- 不要添加任何解释、前缀、后缀或评论\n" +
        "- 不要使用 \"优化后的提示词：\" 这样的前缀\n" +
        "- 不要使用 Markdown 标题或格式\n" +
        "- 不要询问用户任何问题\n" +
        "- 直接输出可以复制使用的提示词文本\n\n" +
        "【如何利用上下文信息】：\n" +
        "1. 如果用户提示词中有模糊的指代（如\"这段代码\"、\"这个文件\"、\"这里\"），根据上下文将其替换为具体描述\n" +
        "2. 根据代码语言类型，添加相关的专业术语和最佳实践\n" +
        "3. 根据选中的代码内容，推断用户可能的意图并在提示词中体现\n" +
        "4. 如果有文件路径信息，可以在提示词中引用具体的文件名或模块名\n" +
        "5. 不要在优化后的提示词中直接包含代码片段，而是描述代码的特征或位置\n\n" +
        "优化原则：\n" +
        "1. 保持用户的原始意图不变\n" +
        "2. 添加必要的上下文和细节\n" +
        "3. 使用清晰、专业的语言\n" +
        "4. 纠正语法错误或拼写错误\n" +
        "5. 如果原始提示词过于模糊，添加合理的假设和约束\n" +
        "6. 保持简洁，不要过度扩展\n\n" +
        "示例1（无上下文）：\n" +
        "用户输入：请优化以下提示词：\\n\\n分析下逻辑\n" +
        "你的输出：请分析当前代码文件的业务逻辑，包括主要功能、数据流向和关键处理步骤。\n\n" +
        "示例2（有上下文）：\n" +
        "用户输入：请优化以下提示词：\\n\\n这段代码有什么问题\\n\\n---\\n以下是相关的上下文信息：\\n\\n【用户选中的代码】\\n```java\\npublic void process() { ... }\\n```\\n\\n【当前文件】UserService.java\\n【语言类型】java\n" +
        "你的输出：请分析 UserService.java 中的 process() 方法，检查是否存在潜在的问题，包括但不限于：空指针异常风险、资源泄漏、线程安全问题、性能瓶颈等，并提供改进建议。";

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
     * 处理增强提示词请求
     * 自动从编辑器获取上下文信息：selectedCode, currentFile, cursorPosition, cursorContext
     */
    private void handleEnhancePrompt(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                JsonObject payload = gson.fromJson(content, JsonObject.class);
                String originalPrompt = payload.has("prompt") ? payload.get("prompt").getAsString() : "";
                String model = payload.has("model") ? payload.get("model").getAsString() : null;

                if (originalPrompt.isEmpty()) {
                    sendEnhanceResult(false, "", "提示词为空");
                    return;
                }

                LOG.info("[PromptEnhancer] 开始增强提示词: " + originalPrompt.substring(0, Math.min(50, originalPrompt.length())) + "...");
                if (model != null) {
                    LOG.info("[PromptEnhancer] 使用模型: " + model);
                }

                // 自动从编辑器获取上下文信息
                JsonObject contextObj = collectEditorContext();

                // 记录上下文信息
                if (contextObj != null) {
                    LOG.info("[PromptEnhancer] 已收集编辑器上下文信息:");
                    if (contextObj.has("selectedCode")) {
                        String selectedCode = contextObj.get("selectedCode").getAsString();
                        LOG.info("  - 选中代码: " + selectedCode.length() + " 字符");
                    }
                    if (contextObj.has("currentFile")) {
                        JsonObject currentFile = contextObj.getAsJsonObject("currentFile");
                        if (currentFile.has("path")) {
                            LOG.info("  - 当前文件: " + currentFile.get("path").getAsString());
                        }
                        if (currentFile.has("language")) {
                            LOG.info("  - 语言类型: " + currentFile.get("language").getAsString());
                        }
                    }
                    if (contextObj.has("cursorPosition")) {
                        JsonObject cursorPos = contextObj.getAsJsonObject("cursorPosition");
                        if (cursorPos.has("line")) {
                            LOG.info("  - 光标位置: 第 " + cursorPos.get("line").getAsInt() + " 行");
                        }
                    }
                    if (contextObj.has("cursorContext")) {
                        String cursorContext = contextObj.get("cursorContext").getAsString();
                        LOG.info("  - 光标上下文: " + cursorContext.length() + " 字符");
                    }
                } else {
                    LOG.info("[PromptEnhancer] 未能获取编辑器上下文信息");
                }

                // 调用 AI 服务进行增强（传递上下文信息）
                String enhancedPrompt = callAIForEnhancement(originalPrompt, model, contextObj);

                if (enhancedPrompt != null && !enhancedPrompt.isEmpty()) {
                    LOG.info("[PromptEnhancer] 增强成功");
                    sendEnhanceResult(true, enhancedPrompt, null);
                } else {
                    LOG.warn("[PromptEnhancer] 增强失败：返回结果为空");
                    sendEnhanceResult(false, "", "增强失败：返回结果为空");
                }

            } catch (Exception e) {
                LOG.error("[PromptEnhancer] 增强提示词失败: " + e.getMessage(), e);
                sendEnhanceResult(false, "", "增强失败: " + e.getMessage());
            }
        });
    }

    /**
     * 从编辑器收集上下文信息
     * 包括：选中的代码、当前文件信息、光标位置、光标周围的代码
     *
     * @return 上下文信息的 JsonObject，如果无法获取则返回 null
     */
    private JsonObject collectEditorContext() {
        AtomicReference<JsonObject> contextRef = new AtomicReference<>(null);

        try {
            // 使用 ReadAction 在读取线程中安全地访问编辑器
            ApplicationManager.getApplication().invokeAndWait(() -> {
                ReadAction.run(() -> {
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
                                // 1. 当前文件信息
                                JsonObject currentFile = new JsonObject();
                                currentFile.addProperty("path", virtualFile.getPath());
                                currentFile.addProperty("language", getLanguageFromExtension(virtualFile.getExtension()));
                                contextObj.add("currentFile", currentFile);
                                hasContext = true;

                                // 2. 选中的代码
                                SelectionModel selectionModel = editor.getSelectionModel();
                                if (selectionModel.hasSelection()) {
                                    String selectedText = selectionModel.getSelectedText();
                                    if (selectedText != null && !selectedText.trim().isEmpty()) {
                                        contextObj.addProperty("selectedCode", selectedText);

                                        // 选中代码的行号范围
                                        int startLine = document.getLineNumber(selectionModel.getSelectionStart()) + 1;
                                        int endLine = document.getLineNumber(selectionModel.getSelectionEnd()) + 1;

                                        JsonObject selectionRange = new JsonObject();
                                        selectionRange.addProperty("startLine", startLine);
                                        selectionRange.addProperty("endLine", endLine);
                                        contextObj.add("selectionRange", selectionRange);
                                    }
                                }

                                // 3. 光标位置
                                int caretOffset = editor.getCaretModel().getOffset();
                                int caretLine = document.getLineNumber(caretOffset) + 1;
                                int caretColumn = caretOffset - document.getLineStartOffset(caretLine - 1) + 1;

                                JsonObject cursorPosition = new JsonObject();
                                cursorPosition.addProperty("line", caretLine);
                                cursorPosition.addProperty("column", caretColumn);
                                contextObj.add("cursorPosition", cursorPosition);

                                // 4. 光标周围的代码（如果没有选中代码）
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
                        LOG.warn("[PromptEnhancer] 获取编辑器上下文失败: " + e.getMessage());
                    }
                });
            });
        } catch (Exception e) {
            LOG.warn("[PromptEnhancer] 调用 ReadAction 失败: " + e.getMessage());
        }

        return contextRef.get();
    }

    /**
     * 获取光标周围的代码上下文
     *
     * @param document 文档对象
     * @param caretLine 光标所在行（0-based）
     * @return 光标周围的代码片段
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
            LOG.warn("[PromptEnhancer] 获取光标上下文失败: " + e.getMessage());
            return null;
        }
    }

    /**
     * 根据文件扩展名获取语言类型
     *
     * @param extension 文件扩展名
     * @return 语言类型名称
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
     * 调用 AI 服务进行提示词增强
     * @param originalPrompt 原始提示词
     * @param model 使用的模型（可选）
     * @param contextObj 上下文信息（可选）
     */
    private String callAIForEnhancement(String originalPrompt, String model, JsonObject contextObj) {
        LOG.info("[PromptEnhancer] 开始调用 AI 服务进行提示词增强");
        LOG.info("[PromptEnhancer] 原始提示词: " + originalPrompt);
        LOG.info("[PromptEnhancer] 使用模型: " + (model != null ? model : "默认"));

        try {
            // 使用 Node.js 脚本调用 AI 服务
            String nodeExecutable = context.getClaudeSDKBridge().getNodeExecutable();
            if (nodeExecutable == null) {
                LOG.error("[PromptEnhancer] Node.js 未配置");
                return null;
            }
            LOG.info("[PromptEnhancer] Node.js 路径: " + nodeExecutable);

            File bridgeDir = context.getClaudeSDKBridge().getSdkTestDir();
            if (bridgeDir == null || !bridgeDir.exists()) {
                LOG.error("[PromptEnhancer] AI Bridge 目录不存在");
                return null;
            }
            LOG.info("[PromptEnhancer] AI Bridge 目录: " + bridgeDir.getAbsolutePath());

            // 构建命令
            List<String> command = new ArrayList<>();
            command.add(nodeExecutable);
            command.add(new File(bridgeDir, "services/prompt-enhancer.js").getAbsolutePath());
            LOG.info("[PromptEnhancer] 执行命令: " + String.join(" ", command));

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);

            // 设置环境变量
            envConfigurator.updateProcessEnvironment(pb, nodeExecutable);

            Process process = pb.start();
            LOG.info("[PromptEnhancer] Node.js 进程已启动");

            // 发送请求数据到 stdin（包含上下文信息）
            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("prompt", originalPrompt);
            stdinInput.addProperty("systemPrompt", ENHANCE_SYSTEM_PROMPT);
            if (model != null && !model.isEmpty()) {
                stdinInput.addProperty("model", model);
            }
            // 添加上下文信息
            if (contextObj != null) {
                stdinInput.add("context", contextObj);
            }

            try (OutputStreamWriter writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
                writer.write(gson.toJson(stdinInput));
                writer.flush();
            }

            // 读取响应
            StringBuilder response = new StringBuilder();
            StringBuilder allOutput = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    allOutput.append(line).append("\n");
                    // 打印所有输出用于调试
                    LOG.info("[PromptEnhancer] Node.js: " + line);
                    if (line.startsWith("[ENHANCED]")) {
                        // 解码特殊标记，还原换行符
                        String enhancedText = line.substring("[ENHANCED]".length()).trim();
                        enhancedText = enhancedText.replace("{{NEWLINE}}", "\n");
                        response.append(enhancedText);
                    }
                }
            }

            int exitCode = process.waitFor();
            LOG.info("[PromptEnhancer] Node.js 进程退出码: " + exitCode);

            if (response.length() == 0 && allOutput.length() > 0) {
                LOG.warn("[PromptEnhancer] 未找到 [ENHANCED] 标记，完整输出:\n" + allOutput);
            }

            return response.toString();

        } catch (Exception e) {
            LOG.error("[PromptEnhancer] 调用 AI 服务失败: " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * 发送增强结果到前端
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

