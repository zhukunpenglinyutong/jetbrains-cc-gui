package com.github.claudecodegui.service;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.FilePath;
import com.intellij.openapi.vcs.VcsException;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangesUtil;
import com.intellij.openapi.vcs.changes.ContentRevision;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.util.Collection;

/**
 * Git commit message generation service.
 * Responsible for generating AI-powered commit messages.
 */
public class GitCommitMessageService {

    private static final Logger LOG = Logger.getInstance(GitCommitMessageService.class);

    private static final int MAX_DIFF_LENGTH = 4000; // Limit diff length to avoid exceeding token limits
    /**
     * Default AI provider.
     * Currently defaults to Claude; may be extended to read from user settings in the future.
     */
    private static final String PROVIDER_CLAUDE = "claude";
    /**
     * Codex provider.
     */
    private static final String PROVIDER_CODEX = "codex";
    /**
     * Default model used for commit message generation.
     * Uses the Sonnet model for a balance between cost and quality.
     */
    private static final String COMMIT_MESSAGE_MODEL = "claude-sonnet-4-20250514";

    /**
     * Prefixes that identify Codex/GPT models.
     */
    private static final String[] CODEX_MODEL_PREFIXES = {
            "gpt-", "o1-", "o3-"
    };

    /**
     * Built-in commit prompt (based on CCG Commits specification).
     * Users can append additional prompts via the settings page, which take priority.
     */
    private static final String BUILTIN_COMMIT_PROMPT = """
            你是一个专门负责 GitHub commit 的高级程序员，请你遵循下面内容，生成高质量 commit
            
            ## 核心规则
            
            ### 基本格式
            ```
            <type>[scope]: <description>
            
            [body]
            
            [footer]
            ```
            
            ### 输出要求
            - 只输出提交消息，不添加签名、标记或元信息
            - 不要包含 "Generated with Claude Code"、"Co-Authored-By" 等内容
            - 不使用 emoji（除非项目规范明确要求）
            - 使用祈使语气、现在时（"add" 而非 "added"）
            - 主题行不超过 72 字符
            - 保持简洁专业
            - **必须用 `<commit></commit>` 标签包裹，标签外不要有任何内容**
            - 语言默认使用英文
            
            ## 提交类型映射
            
            | Type | 描述 | 使用场景 |
            |------|------|---------|
            | `feat` | 新功能 | 添加新功能 |
            | `fix` | Bug修复 | 修复问题 |
            | `docs` | 文档 | 仅文档变更 |
            | `style` | 代码风格 | 格式化、缺少分号等 |
            | `refactor` | 重构 | 既不修复bug也不添加功能 |
            | `perf` | 性能优化 | 性能改进 |
            | `test` | 测试 | 添加或修改测试 |
            | `chore` | 构建/工具 | 构建过程或工具变更 |
            | `ci` | CI/CD | CI配置变更 |
            | `build` | 构建系统 | 影响构建系统的变更 |
            | `revert` | 回滚 | 回滚之前的提交 |
            
            ## Scope（范围）指南
            
            Scope 应该是一个描述代码库部分的名词，在整个项目中保持一致，简短且有意义。
            
            常见 Scope 示例：
            - 模块级别：api, auth, ui, db, config, deps
            - 组件级别：button, modal, header, footer
            - 功能级别：parser, compiler, validator, router
            
            ## Body（正文）编写指南
            
            Body 应该：
            - 解释**是什么**变更和**为什么**变更（而不是如何变更）
            - 使用项目符号列出多个变更
            - 包含变更的动机
            - 对比新旧行为
            - 引用相关问题或决策
            - 每行不超过 72 个字符
            
            ## Footer（页脚）编写指南
            
            Footer 包含：
            - Breaking Changes：BREAKING CHANGE: rename config.auth to config.authentication
            - Issue 引用：Closes: #123, #124 / Fixes: #125 / Refs: #126
            
            ## 最佳实践
            
            ### 应该做的
            - 使用现在时、祈使语气（"add" 而不是 "added"）
            - 第一行保持在 50 个字符以内（最多 72）
            - 描述的首字母大写
            - 主题行末尾不加句号
            - 主题和正文之间用空行分隔
            - 使用正文解释是什么和为什么（而不是如何）
            - 引用相关 issue 和破坏性变更
            
            ### 不应该做的
            - 在一个提交中混合多个逻辑变更
            - 在主题中包含实现细节
            - 使用过去时（"added" 而不是 "add"）
            - 创建过大的提交（难以审查）
            - 提交损坏的代码（除非是 WIP）
            - 包含敏感信息
            """;

    // XML tags used to extract the commit message
    private static final String COMMIT_TAG_START = "<commit>";
    private static final String COMMIT_TAG_END = "</commit>";

    private final Project project;
    private final CodemossSettingsService settingsService;

    public GitCommitMessageService(@NotNull Project project) {
        this.project = project;
        this.settingsService = new CodemossSettingsService();
    }

    /**
     * Generate a commit message.
     *
     * @param changes  The selected file changes
     * @param model    The AI model to use
     * @param callback The callback interface
     */
    public void generateCommitMessage(
            @NotNull Collection<Change> changes,
            @NotNull String model,
            @NotNull CommitMessageCallback callback
    ) {
        try {
            // 1. Generate git diff
            String diff = generateGitDiff(changes);
            if (diff.isEmpty()) {
                callback.onError(ClaudeCodeGuiBundle.message("commit.noChangesFound"));
                return;
            }

            // 2. Build the full prompt (built-in + user's additional prompt + diff)
            String fullPrompt = buildFullPrompt(diff);

            // 3. Call the AI SDK with the specified model
            callAIService(fullPrompt, model, callback);

        } catch (Exception e) {
            LOG.error("Failed to generate commit message", e);
            callback.onError(e.getMessage());
        }
    }

    /**
     * Generate git diff.
     */
    private String generateGitDiff(@NotNull Collection<Change> changes) {
        StringBuilder diff = new StringBuilder();

        for (Change change : changes) {
            try {
                FilePath filePath = ChangesUtil.getFilePath(change);
                Change.Type changeType = change.getType();

                diff.append("\n=== ").append(changeType.name()).append(": ")
                        .append(filePath.getPath()).append(" ===\n");

                ContentRevision beforeRevision = change.getBeforeRevision();
                ContentRevision afterRevision = change.getAfterRevision();

                if (changeType == Change.Type.NEW && afterRevision != null) {
                    // New file: include content up to 500 characters
                    String content = afterRevision.getContent();
                    if (content != null && content.length() <= 500) {
                        diff.append("+++ ").append(content).append("\n");
                    } else if (content != null) {
                        diff.append("+++ [文件过大，仅显示前500字符]\n");
                        diff.append(content, 0, Math.min(500, content.length())).append("\n");
                    }
                } else if (changeType == Change.Type.DELETED && beforeRevision != null) {
                    // Deleted file marker
                    diff.append("--- 文件已删除\n");
                } else if (changeType == Change.Type.MODIFICATION && beforeRevision != null && afterRevision != null) {
                    // Modified file: generate a simple diff
                    String before = beforeRevision.getContent();
                    String after = afterRevision.getContent();

                    if (before != null && after != null) {
                        diff.append(generateSimpleDiff(before, after));
                    }
                }

                // Limit total length
                if (diff.length() > MAX_DIFF_LENGTH) {
                    diff.append("\n... (diff 过长，已截断)");
                    break;
                }

            } catch (VcsException e) {
                LOG.warn("Failed to get diff for change: " + e.getMessage());
            }
        }

        return diff.toString();
    }

    /**
     * Generate a simple diff (showing added/removed lines).
     */
    private String generateSimpleDiff(String before, String after) {
        String[] beforeLines = before.split("\n");
        String[] afterLines = after.split("\n");

        StringBuilder diff = new StringBuilder();
        int maxLines = Math.max(beforeLines.length, afterLines.length);
        int shownLines = 0;
        int maxShownLines = 30; // Maximum lines to display

        for (int i = 0; i < maxLines && shownLines < maxShownLines; i++) {
            String beforeLine = i < beforeLines.length ? beforeLines[i] : "";
            String afterLine = i < afterLines.length ? afterLines[i] : "";

            if (!beforeLine.equals(afterLine)) {
                if (!beforeLine.isEmpty()) {
                    diff.append("- ").append(beforeLine).append("\n");
                    shownLines++;
                }
                if (!afterLine.isEmpty() && shownLines < maxShownLines) {
                    diff.append("+ ").append(afterLine).append("\n");
                    shownLines++;
                }
            }
        }

        if (maxLines > maxShownLines) {
            diff.append("... (更多变更已省略)\n");
        }

        return diff.toString();
    }

    /**
     * Get the user's additional prompt (optional).
     */
    private String getUserAdditionalPrompt() {
        try {
            String userPrompt = settingsService.getCommitPrompt();
            // Return empty if the user hasn't configured a prompt or set the default value
            if (userPrompt == null || userPrompt.trim().isEmpty()) {
                return "";
            }
            // Treat the old default value as not configured
            if (userPrompt.equals("你是一个commit提交专员，请你阅读git记录，帮我生成commit记录")) {
                return "";
            }
            return userPrompt.trim();
        } catch (Exception e) {
            LOG.warn("Failed to get user additional prompt from settings", e);
            return "";
        }
    }

    /**
     * Build the full prompt.
     * Logic: built-in prompt + user's additional prompt (takes priority) + git diff.
     */
    private String buildFullPrompt(String diff) {
        StringBuilder prompt = new StringBuilder();

        // 1. Built-in commit prompt
        prompt.append(BUILTIN_COMMIT_PROMPT);

        // 2. User's additional prompt (if any, takes priority)
        String userAdditionalPrompt = getUserAdditionalPrompt();
        if (!userAdditionalPrompt.isEmpty()) {
            prompt.append("\n\n## 用户附加要求（优先遵循）\n\n");
            prompt.append("以下是用户的额外要求，请在生成 commit message 时优先考虑这些要求：\n\n");
            prompt.append(userAdditionalPrompt);
        }

        // 3. Git diff content
        prompt.append("\n\n---\n\n");
        prompt.append("以下是 git diff 信息，请根据以上规则生成 commit message：\n\n");
        prompt.append("```diff\n");
        prompt.append(diff);
        prompt.append("\n```");

        // 4. Output format requirements (enforce XML tag wrapping for easy parsing)
        prompt.append("\n\n【输出格式要求 - 必须严格遵守】\n");
        prompt.append("请将 commit message 用 XML 标签包裹输出，格式如下：\n");
        prompt.append("<commit>\n");
        prompt.append("type(scope): description\n");
        prompt.append("\n");
        prompt.append("optional body\n");
        prompt.append("</commit>\n\n");
        prompt.append("重要规则：\n");
        prompt.append("1. 必须使用 <commit> 和 </commit> 标签包裹\n");
        prompt.append("2. 标签外不要有任何其他内容（不要分析、不要解释、不要说明）\n");

        return prompt.toString();
    }

    /**
     * Call the AI service.
     * Automatically detects the appropriate provider based on the model name.
     */
    private void callAIService(String prompt, String model, CommitMessageCallback callback) {
//        JsonObject commitAiConfig = getCommitAiConfig();
//        String effectiveProvider = getResolvedCommitAiProvider(commitAiConfig);
//
//        if (effectiveProvider == null) {
//            callback.onError(ClaudeCodeGuiBundle.message("commit.noAvailableProvider"));
//            return;
//        }
//
//        if (PROVIDER_CODEX.equals(effectiveProvider)) {
//            callCodexAPI(prompt, getResolvedCommitAiModel(commitAiConfig, PROVIDER_CODEX), callback);
//            return;
//        }
//
//        callClaudeAPI(prompt, getResolvedCommitAiModel(commitAiConfig, PROVIDER_CLAUDE), callback);


        // Detect provider based on model name
        String provider = detectProviderForModel(model);

        if (PROVIDER_CODEX.equals(provider)) {
            callCodexAPI(prompt, model, callback);
        } else {
            callClaudeAPI(prompt, model, callback);
        }
    }

    protected JsonObject getCommitAiConfig() throws IOException {
        return settingsService.getCommitAiConfig();
    }

    private String getResolvedCommitAiProvider(JsonObject commitAiConfig) {
        if (commitAiConfig == null
                || !commitAiConfig.has("effectiveProvider")
                || commitAiConfig.get("effectiveProvider").isJsonNull()) {
            return null;
        }
        String provider = commitAiConfig.get("effectiveProvider").getAsString().trim();
        return provider.isEmpty() ? null : provider;
    }

    private String getResolvedCommitAiModel(JsonObject commitAiConfig, String provider) {
        if (commitAiConfig == null
                || !commitAiConfig.has("models")
                || !commitAiConfig.get("models").isJsonObject()) {
            return null;
        }
        JsonObject models = commitAiConfig.getAsJsonObject("models");
        if (!models.has(provider) || models.get(provider).isJsonNull()) {
            return null;
        }
        String model = models.get(provider).getAsString().trim();
        return model.isEmpty() ? null : model;
    }

    /**
     * Detect the appropriate provider for a given model name.
     * Codex/GPT models (gpt-*, o1-*, o3-*) use Codex provider.
     * Claude models (claude-*) use Claude provider.
     * Custom/unknown models default to Claude provider.
     */
    private String detectProviderForModel(String model) {
        if (model == null || model.isEmpty()) {
            return PROVIDER_CLAUDE;
        }

        String lowerModel = model.toLowerCase();
        for (String prefix : CODEX_MODEL_PREFIXES) {
            if (lowerModel.startsWith(prefix)) {
                return PROVIDER_CODEX;
            }
        }

        return PROVIDER_CLAUDE;
    }

    /**
     * Get the current provider.
     * <p>
     * Note: Currently always returns the default provider (claude).
     * In the future, this can be extended to read the user's preferred provider from settings or session state.
     */
    private String getCurrentProvider() {
        // Future extension: read the user's default provider from CodemossSettingsService
        // e.g.: return settingsService.getDefaultProvider();
        return PROVIDER_CLAUDE;
    }

    /**
     * Call the Claude API.
     */
    private void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
        ClaudeSDKBridge bridge = new ClaudeSDKBridge();
        try {
            // Simple callback handler
            StringBuilder result = new StringBuilder();
            final StringBuilder displayedContent = new StringBuilder();
            final boolean[] hasValidContent = {false}; // Track if we have valid commit message content
            final boolean[] hasShownModel = {false}; // Track if we've shown the model info

            // Show initial status with model info
            ApplicationManager.getApplication().invokeLater(() -> {
                String modelDisplay = getShortModelName(model);
                String status = ClaudeCodeGuiBundle.message("commit.progress.connecting") + "\n" +
                        ClaudeCodeGuiBundle.message("commit.progress.model") + ": " + modelDisplay;
                callback.onProgressWithModel(status, model);
                hasShownModel[0] = true;
            });

            // Use the 12-parameter sendMessage overload:
            // - model: user-selected model
            // - streaming: true (streaming mode for real-time updates)
            // - disableThinking: true (disable thinking mode to avoid verbose reasoning output)
            bridge.sendMessage(
                    "git-commit-message",      // channelId
                    prompt,                     // message
                    null,                       // sessionId (null = new session)
                    project.getBasePath(),      // cwd
                    null,                       // attachments (not needed)
                    null,                       // permissionMode (use default)
                    model,                      // model (user-selected)
                    null,                       // openedFiles
                    null,                       // agentPrompt
                    true,                       // streaming (streaming mode for real-time updates)
                    true,                       // disableThinking (disable thinking mode)
                    new MessageCallback() {
                        @Override
                        public void onMessage(String type, String content) {
                            // Process all content types for progress updates
                            if ("content".equals(type) || "assistant".equals(type) || "text".equals(type)) {
                                // Skip thinking content (typically starts with specific markers)
//                            if (!isThinkingContent(content)) {
//                                result.append(content);
//                            }

                                // Always collect content for result
                                result.append(content);
                                displayedContent.append(content);

                                // Update progress in real-time (on EDT thread)
                                ApplicationManager.getApplication().invokeLater(() -> {
                                    String currentResult = displayedContent.toString();

                                    // Try to extract and display commit message
                                    String cleaned = extractPartialCommitMessage(currentResult);

                                    if (!cleaned.isEmpty()) {
                                        // We have valid commit message content
                                        hasValidContent[0] = true;
                                        String modelDisplay = getShortModelName(model);
                                        String status = cleaned + "\n\n---\n" +
                                                ClaudeCodeGuiBundle.message("commit.progress.model") + ": " + modelDisplay;
                                        callback.onProgressWithModel(status, model);
                                    } else if (!hasValidContent[0] && hasShownModel[0]) {
                                        // Still waiting for valid content, show processing status
                                        String status = getProcessingStatus(currentResult);
                                        String modelDisplay = getShortModelName(model);
                                        status += "\n" + ClaudeCodeGuiBundle.message("commit.progress.model") + ": " + modelDisplay;
                                        callback.onProgressWithModel(status, model);
                                    }
                                });
                            }
                        }

                        @Override
                        public void onError(String error) {
                            bridge.shutdownDaemon();
                            callback.onError(error);
                        }

                        @Override
                        public void onComplete(SDKResult sdkResult) {
                            bridge.shutdownDaemon();
                            String commitMessage = result.length() > 0
                                    ? result.toString().trim()
                                    : sdkResult.finalResult.trim();

                            if (commitMessage.isEmpty()) {
                                callback.onError(ClaudeCodeGuiBundle.message("commit.emptyMessage"));
                            } else {
                                callback.onSuccess(cleanupCommitMessage(commitMessage));
                            }
                        }
                    }
            );
        } catch (Exception e) {
            bridge.shutdownDaemon();
            LOG.error("Failed to call Claude API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    /**
     * Call the Codex API.
     */
    private void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
        CodexSDKBridge bridge = new CodexSDKBridge();
        try {
            // Simple callback handler
            StringBuilder result = new StringBuilder();
            final StringBuilder displayedContent = new StringBuilder();
            final boolean[] hasValidContent = {false}; // Track if we have valid commit message content
            final boolean[] hasShownModel = {false}; // Track if we've shown the model info

            // Show initial status with model info
            ApplicationManager.getApplication().invokeLater(() -> {
                String modelDisplay = getShortModelName(model);
                String status = ClaudeCodeGuiBundle.message("commit.progress.connecting") + "\n" +
                        ClaudeCodeGuiBundle.message("commit.progress.model") + ": " + modelDisplay;
                callback.onProgressWithModel(status, model);
                hasShownModel[0] = true;
            });

            // CodexSDKBridge.sendMessage requires 10 parameters:
            // (channelId, message, threadId, cwd, attachments, permissionMode, model, agentPrompt, reasoningEffort, callback)
            bridge.sendMessage(
                    "git-commit-message",      // channelId
                    prompt,                     // message
                    null,                       // threadId (null = new session)
                    project.getBasePath(),      // cwd
                    null,                       // attachments (not needed)
                    null,                       // permissionMode (use default)
                    model,                      // model (user-selected)
                    null,                       // agentPrompt (not needed)
                    null,                       // reasoningEffort (use default)
                    new MessageCallback() {
                        @Override
                        public void onMessage(String type, String content) {
                            // Process all content types for progress updates
                            if ("content".equals(type) || "assistant".equals(type) || "text".equals(type)) {
                                // Skip thinking content
//                            if (!isThinkingContent(content)) {
//                                result.append(content);
//                            }
                                // Always collect content for result
                                result.append(content);
                                displayedContent.append(content);

                                // Update progress in real-time (on EDT thread)
                                ApplicationManager.getApplication().invokeLater(() -> {
                                    String currentResult = displayedContent.toString();

                                    // Try to extract and display commit message
                                    String cleaned = extractPartialCommitMessage(currentResult);

                                    if (!cleaned.isEmpty()) {
                                        // We have valid commit message content
                                        hasValidContent[0] = true;
                                        String modelDisplay = getShortModelName(model);
                                        String status = cleaned + "\n\n---\n" +
                                                ClaudeCodeGuiBundle.message("commit.progress.model") + ": " + modelDisplay;
                                        callback.onProgressWithModel(status, model);
                                    } else if (!hasValidContent[0] && hasShownModel[0]) {
                                        // Still waiting for valid content, show processing status
                                        String status = getProcessingStatus(currentResult);
                                        String modelDisplay = getShortModelName(model);
                                        status += "\n" + ClaudeCodeGuiBundle.message("commit.progress.model") + ": " + modelDisplay;
                                        callback.onProgressWithModel(status, model);
                                    }
                                });
                            }
                        }

                        @Override
                        public void onError(String error) {
                            bridge.cleanupAllProcesses();
                            callback.onError(error);
                        }

                        @Override
                        public void onComplete(SDKResult sdkResult) {
                            bridge.cleanupAllProcesses();
                            String commitMessage = result.length() > 0
                                    ? result.toString().trim()
                                    : sdkResult.finalResult.trim();

                            if (commitMessage.isEmpty()) {
                                callback.onError(ClaudeCodeGuiBundle.message("commit.emptyMessage"));
                            } else {
                                callback.onSuccess(cleanupCommitMessage(commitMessage));
                            }
                        }
                    }
            );
        } catch (Exception e) {
            bridge.cleanupAllProcesses();
            LOG.error("Failed to call Codex API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    /**
     * Clean up and extract the commit message.
     * Prioritizes extraction from XML tags, with multiple format fallbacks.
     */
    private String cleanupCommitMessage(String message) {
        if (message == null || message.isEmpty()) {
            return "";
        }

        String cleaned = message;

        // 0. Remove thinking markers first (e.g. "Thinking >" etc.)
        cleaned = removeThinkingMarkers(cleaned);

        // 1. First try to extract from <commit>...</commit> tags
        int startIdx = cleaned.indexOf(COMMIT_TAG_START);
        int endIdx = cleaned.indexOf(COMMIT_TAG_END);

        if (startIdx != -1 && endIdx != -1 && endIdx > startIdx) {
            cleaned = cleaned.substring(startIdx + COMMIT_TAG_START.length(), endIdx);
            // Convert literal \n to actual newlines
            return convertLiteralNewlines(cleaned.trim());
        }

        // 2. Fallback: try to extract from markdown code blocks
        if (cleaned.contains("```")) {
            int codeBlockStart = cleaned.indexOf("```");
            // Find the first newline after the code block opener
            int contentStart = cleaned.indexOf('\n', codeBlockStart);
            if (contentStart != -1) {
                int codeBlockEnd = cleaned.indexOf("```", contentStart);
                if (codeBlockEnd != -1) {
                    cleaned = cleaned.substring(contentStart + 1, codeBlockEnd);
                    return convertLiteralNewlines(cleaned.trim());
                }
            }
        }

        // 3. Fallback: try to extract the first conventional commit formatted line
        // Format: type(scope): description or type: description
        String[] lines = cleaned.split("\n");
        for (String line : lines) {
            String trimmedLine = line.trim();
            if (isConventionalCommitLine(trimmedLine)) {
                // After finding the first line, continue collecting the body until hitting analysis sections
                StringBuilder result = new StringBuilder(trimmedLine);
                int idx = java.util.Arrays.asList(lines).indexOf(line);
                boolean inBody = false;

                for (int i = idx + 1; i < lines.length; i++) {
                    String nextLine = lines[i].trim();
                    // Stop when hitting analysis keywords
                    if (isAnalysisSection(nextLine)) {
                        break;
                    }
                    // Empty line indicates body start
                    if (nextLine.isEmpty()) {
                        inBody = true;
                        result.append("\n");
                        continue;
                    }
                    // Collect body content
                    if (inBody && !nextLine.startsWith("#") && !nextLine.startsWith("*")) {
                        result.append("\n").append(nextLine);
                    } else if (!inBody) {
                        // Not in body yet but hit a non-empty line, means single-line commit
                        break;
                    }
                }
                return convertLiteralNewlines(result.toString().trim());
            }
        }

        // 4. Last resort fallback: return the first few lines of raw content (excluding analysis sections)
        StringBuilder fallback = new StringBuilder();
        for (String line : lines) {
            String trimmedLine = line.trim();
            if (isAnalysisSection(trimmedLine)) {
                break;
            }
            if (!trimmedLine.isEmpty()) {
                fallback.append(trimmedLine).append("\n");
            }
            // Take at most 5 lines
            if (fallback.toString().split("\n").length >= 5) {
                break;
            }
        }

        return convertLiteralNewlines(fallback.toString().trim());
    }

    /**
     * Convert literal \n characters to actual newlines and clean up excess blank lines.
     */
    private String convertLiteralNewlines(String text) {
        if (text == null) {
            return null;
        }
        // Convert literal \n (two characters) to actual newlines
        String result = text.replace("\\n", "\n");

        // Remove leading blank lines
        result = result.replaceFirst("^\\n+", "");

        // Collapse multiple consecutive blank lines into a single one (preserve the conventional commit title/body separator)
        result = result.replaceAll("\\n{3,}", "\n\n");

        return result.trim();
    }

    /**
     * Check whether a line follows the conventional commit format.
     */
    private boolean isConventionalCommitLine(String line) {
        if (line == null || line.isEmpty()) {
            return false;
        }
        // Match: feat:, fix:, refactor:, feat(scope):, etc.
        String[] types = {"feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci", "style", "build"};
        for (String type : types) {
            if (line.startsWith(type + ":") || line.startsWith(type + "(")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Check whether a line belongs to an analysis section (content to exclude).
     */
    private boolean isAnalysisSection(String line) {
        if (line == null) {
            return false;
        }
        String[] analysisKeywords = {
                "分析说明", "变更特征", "分析：", "说明：", "解释：", "备注：",
                "Analysis:", "Explanation:", "Note:", "---", "===",
                "1. 类型", "2. Scope", "3. 描述", "4. Body",
                "• ", "- 无需", "- 不涉及"
        };
        for (String keyword : analysisKeywords) {
            if (line.contains(keyword)) {
                return true;
            }
        }
        // Check for numbered list items (e.g. "1. xxx")
        if (line.matches("^\\d+\\.\\s+.*")) {
            return true;
        }
        return false;
    }

    /**
     * Check whether the content is a thinking/reasoning process.
     */
    private boolean isThinkingContent(String content) {
        if (content == null || content.isEmpty()) {
            return false;
        }
        // Common markers for thinking/reasoning content
        String[] thinkingMarkers = {
                "思考", "thinking", "Thinking", "<thinking>", "</thinking>",
                "让我分析", "让我思考", "我来分析", "首先分析",
                "Let me think", "Let me analyze"
        };
        String trimmed = content.trim();
        for (String marker : thinkingMarkers) {
            if (trimmed.startsWith(marker) || trimmed.contains("<thinking>")) {
                return true;
            }
        }
        return false;
    }

    /**
     * Remove thinking markers and their content.
     */
    private String removeThinkingMarkers(String content) {
        if (content == null || content.isEmpty()) {
            return content;
        }

        String result = content;

        // Remove <thinking>...</thinking> tags and their content
        while (result.contains("<thinking>") && result.contains("</thinking>")) {
            int start = result.indexOf("<thinking>");
            int end = result.indexOf("</thinking>") + "</thinking>".length();
            if (start < end) {
                result = result.substring(0, start) + result.substring(end);
            } else {
                break;
            }
        }

        // Remove UI thinking markers like "Thinking >" etc.
        String[] uiMarkers = {"思考 ▸", "思考▸", "思考 ►", "思考►", "Thinking ▸", "Thinking▸"};
        for (String marker : uiMarkers) {
            result = result.replace(marker, "");
        }

        // Remove leading blank lines
        result = result.replaceFirst("^\\s*\\n+", "");

        return result.trim();
    }

    /**
     * Extract partial commit message from streaming content.
     * This is more lenient than cleanupCommitMessage() to show progress.
     */
    private String extractPartialCommitMessage(String content) {
        if (content == null || content.isEmpty()) {
            return "";
        }

        // First remove thinking markers
        String cleaned = removeThinkingMarkers(content);
        if (cleaned.isEmpty()) {
            return "";
        }

        // Try to extract from <commit>...</commit> tags
        int startIdx = cleaned.indexOf(COMMIT_TAG_START);
        int endIdx = cleaned.indexOf(COMMIT_TAG_END);

        if (startIdx != -1 && endIdx > startIdx) {
            String extracted = cleaned.substring(startIdx + COMMIT_TAG_START.length(), endIdx);
            return convertLiteralNewlines(extracted.trim());
        }

        // Try to extract partial conventional commit format
        String[] lines = cleaned.split("\n");
        for (String line : lines) {
            String trimmedLine = line.trim();
            if (isConventionalCommitLine(trimmedLine)) {
                // Found the title line, include it and any following body content
                StringBuilder result = new StringBuilder(trimmedLine);
                int idx = java.util.Arrays.asList(lines).indexOf(line);
                boolean inBody = false;

                for (int i = idx + 1; i < lines.length; i++) {
                    String nextLine = lines[i].trim();
                    // Stop when hitting analysis keywords
                    if (isAnalysisSection(nextLine)) {
                        break;
                    }
                    // Empty line indicates body start
                    if (nextLine.isEmpty()) {
                        inBody = true;
                        result.append("\n");
                        continue;
                    }
                    // Collect body content
                    if (inBody && !nextLine.startsWith("#") && !nextLine.startsWith("*")) {
                        result.append("\n").append(nextLine);
                    } else if (!inBody) {
                        // Not in body yet but hit a non-empty line, means single-line commit
                        break;
                    }
                }
                return convertLiteralNewlines(result.toString().trim());
            }
        }

        return ""; // No valid commit message found yet
    }

    /**
     * Get processing status message based on current content.
     * This shows meaningful progress when no valid commit message is available yet.
     */
    private String getProcessingStatus(String content) {
        if (content == null || content.isEmpty()) {
            return ClaudeCodeGuiBundle.message("commit.progress.initializing") + "...";
        }

        // Remove thinking markers first
        String cleaned = removeThinkingMarkers(content);

        // If we have <commit> tag but not closed yet
        if (cleaned.contains(COMMIT_TAG_START) && !cleaned.contains(COMMIT_TAG_END)) {
            return ClaudeCodeGuiBundle.message("commit.progress.generating") + "...";
        }

        // If we have some content but no valid format yet
        if (cleaned.length() > 50) {
            return ClaudeCodeGuiBundle.message("commit.progress.processing") + "...";
        }

        // Default status
        return ClaudeCodeGuiBundle.message("commit.progress.analyzing") + "...";
    }

    /**
     * Get a short display name for the model.
     */
    private String getShortModelName(String model) {
        if (model == null || model.isEmpty()) {
            return "Unknown";
        }

        // Extract short name from model ID
        if (model.contains("sonnet")) {
            return "Sonnet";
        } else if (model.contains("opus")) {
            return "Opus";
        } else if (model.contains("haiku")) {
            return "Haiku";
        } else if (model.contains("gpt-")) {
            // GPT models
            if (model.contains("-5.5")) return "GPT-5.5";
            if (model.contains("-5.4")) return "GPT-5.4";
            if (model.contains("-5.3")) return "GPT-5.3";
            if (model.contains("-5.2")) return "GPT-5.2";
            if (model.contains("-5.1")) return "GPT-5.1";
            if (model.contains("o3-mini")) return "O3 Mini";
            if (model.contains("o3")) return "O3";
            if (model.contains("o1-mini")) return "O1 Mini";
            if (model.contains("o1-preview")) return "O1 Preview";
            if (model.contains("o1")) return "O1";
            return model;
        } else if (model.contains("claude-")) {
            // Custom Claude models - just show the ID
            return model;
        } else {
            // Custom models - just show the ID
            return model;
        }
    }

    /**
     * Commit message generation callback interface.
     */
    public interface CommitMessageCallback {
        void onSuccess(String commitMessage);

        void onError(String error);

        void onProgress(String partialMessage); // Real-time streaming updates

        void onProgressWithModel(String partialMessage, String model); // Update with model info
    }
}
