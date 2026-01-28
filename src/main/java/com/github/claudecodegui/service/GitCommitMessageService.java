package com.github.claudecodegui.service;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.CodemossSettingsService;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ContentRevision;
import com.intellij.openapi.vcs.FilePath;
import com.intellij.openapi.vcs.VcsException;
import com.intellij.openapi.vcs.changes.ChangesUtil;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.util.Collection;

/**
 * Git Commit Message 生成服务
 * 负责生成 AI commit message
 */
public class GitCommitMessageService {

    private static final Logger LOG = Logger.getInstance(GitCommitMessageService.class);

    private static final int MAX_DIFF_LENGTH = 4000; // 限制 diff 长度避免 token 超限

    /**
     * Commit Message 生成使用的默认模型
     * 使用 Sonnet 模型在成本和质量之间取得平衡
     */
    private static final String COMMIT_MESSAGE_MODEL = "claude-sonnet-4-20250514";

    /**
     * 默认 AI 提供者
     * 当前系统默认使用 Claude，未来可扩展为从用户设置读取
     */
    private static final String DEFAULT_PROVIDER = "claude";

    /**
     * 内置的 Commit 提示词（基于 CCG Commits 规范）
     * 用户可以通过设置页面附加额外的提示词，会优先遵循用户的附加内容
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

    // 用于提取 commit 消息的 XML 标签
    private static final String COMMIT_TAG_START = "<commit>";
    private static final String COMMIT_TAG_END = "</commit>";

    private final Project project;
    private final CodemossSettingsService settingsService;

    /**
     * Commit Message 生成回调接口
     */
    public interface CommitMessageCallback {
        void onSuccess(String commitMessage);
        void onError(String error);
    }

    public GitCommitMessageService(@NotNull Project project) {
        this.project = project;
        this.settingsService = new CodemossSettingsService();
    }

    /**
     * 生成 commit message
     *
     * @param changes 选中的文件变更
     * @param callback 回调接口
     */
    public void generateCommitMessage(
            @NotNull Collection<Change> changes,
            @NotNull CommitMessageCallback callback
    ) {
        try {
            // 1. 生成 git diff
            String diff = generateGitDiff(changes);
            if (diff.isEmpty()) {
                callback.onError(ClaudeCodeGuiBundle.message("commit.noChangesFound"));
                return;
            }

            // 2. 构造完整的 prompt（内置提示词 + 用户附加提示词 + diff）
            String fullPrompt = buildFullPrompt(diff);

            // 3. 调用 AI SDK
            callAIService(fullPrompt, callback);

        } catch (Exception e) {
            LOG.error("Failed to generate commit message", e);
            callback.onError(e.getMessage());
        }
    }

    /**
     * 生成 git diff
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
                    // 新增文件
                    String content = afterRevision.getContent();
                    if (content != null && content.length() <= 500) {
                        diff.append("+++ ").append(content).append("\n");
                    } else if (content != null) {
                        diff.append("+++ [文件过大，仅显示前500字符]\n");
                        diff.append(content, 0, Math.min(500, content.length())).append("\n");
                    }
                } else if (changeType == Change.Type.DELETED && beforeRevision != null) {
                    // 删除文件
                    diff.append("--- 文件已删除\n");
                } else if (changeType == Change.Type.MODIFICATION && beforeRevision != null && afterRevision != null) {
                    // 修改文件 - 生成简单的 diff
                    String before = beforeRevision.getContent();
                    String after = afterRevision.getContent();

                    if (before != null && after != null) {
                        diff.append(generateSimpleDiff(before, after));
                    }
                }

                // 限制总长度
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
     * 生成简单的 diff（显示增删的行）
     */
    private String generateSimpleDiff(String before, String after) {
        String[] beforeLines = before.split("\n");
        String[] afterLines = after.split("\n");

        StringBuilder diff = new StringBuilder();
        int maxLines = Math.max(beforeLines.length, afterLines.length);
        int shownLines = 0;
        int maxShownLines = 30; // 最多显示30行

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
     * 获取用户附加的提示词（可选）
     */
    private String getUserAdditionalPrompt() {
        try {
            String userPrompt = settingsService.getCommitPrompt();
            // 如果用户没有设置或者设置的是默认值，返回空
            if (userPrompt == null || userPrompt.trim().isEmpty()) {
                return "";
            }
            // 如果是旧的默认值，也视为没有设置
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
     * 构造完整的 prompt
     * 逻辑：内置提示词 + 用户附加提示词（优先遵循用户的附加内容）+ git diff
     */
    private String buildFullPrompt(String diff) {
        StringBuilder prompt = new StringBuilder();

        // 1. 添加内置提示词
        prompt.append(BUILTIN_COMMIT_PROMPT);

        // 2. 添加用户附加的提示词（如果有）
        String userAdditionalPrompt = getUserAdditionalPrompt();
        if (!userAdditionalPrompt.isEmpty()) {
            prompt.append("\n\n## 用户附加要求（优先遵循）\n\n");
            prompt.append("以下是用户的额外要求，请在生成 commit message 时优先考虑这些要求：\n\n");
            prompt.append(userAdditionalPrompt);
        }

        // 3. 添加 git diff 信息
        prompt.append("\n\n---\n\n");
        prompt.append("以下是 git diff 信息，请根据以上规则生成 commit message：\n\n");
        prompt.append("```diff\n");
        prompt.append(diff);
        prompt.append("\n```");

        // 4. 添加输出格式要求（强制使用 XML 标签包裹，方便解析）
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
     * 调用 AI 服务
     */
    private void callAIService(String prompt, CommitMessageCallback callback) {
        // 获取当前使用的 provider
        String currentProvider = getCurrentProvider();

        if ("codex".equals(currentProvider)) {
            callCodexAPI(prompt, callback);
        } else {
            callClaudeAPI(prompt, callback);
        }
    }

    /**
     * 获取当前使用的 provider
     *
     * 注意：当前始终返回默认 provider (claude)。
     * 未来扩展时可以从用户设置或会话状态中读取用户偏好的 provider。
     */
    private String getCurrentProvider() {
        // 未来可扩展：从 CodemossSettingsService 读取用户设置的默认 provider
        // 例如：return settingsService.getDefaultProvider();
        return DEFAULT_PROVIDER;
    }

    /**
     * 调用 Claude API
     */
    private void callClaudeAPI(String prompt, CommitMessageCallback callback) {
        try {
            ClaudeSDKBridge bridge = new ClaudeSDKBridge();

            // 创建简单的回调处理
            StringBuilder result = new StringBuilder();

            // 使用 12 参数版本的 sendMessage，指定：
            // - model: COMMIT_MESSAGE_MODEL (使用 Sonnet 模型)
            // - streaming: false (非流式，一次性返回完整结果)
            // - disableThinking: true (禁用思考模式，避免返回大量思考内容)
            bridge.sendMessage(
                "git-commit-message",      // channelId
                prompt,                     // message
                null,                       // sessionId (null 表示新会话)
                project.getBasePath(),      // cwd
                null,                       // attachments (不需要附件)
                null,                       // permissionMode (使用默认)
                COMMIT_MESSAGE_MODEL,       // model (使用 sonnet)
                null,                       // openedFiles
                null,                       // agentPrompt
                false,                      // streaming (非流式模式)
                true,                       // disableThinking (禁用思考模式)
                new MessageCallback() {
                    @Override
                    public void onMessage(String type, String content) {
                        // 只收集 assistant 类型的内容，忽略 thinking/reasoning
                        if ("content".equals(type) || "assistant".equals(type) || "text".equals(type)) {
                            // 检查是否是思考过程（通常以特定标记开头）
                            if (!isThinkingContent(content)) {
                                result.append(content);
                            }
                        }
                    }

                    @Override
                    public void onError(String error) {
                        callback.onError(error);
                    }

                    @Override
                    public void onComplete(SDKResult sdkResult) {
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
            LOG.error("Failed to call Claude API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    /**
     * 调用 Codex API
     */
    private void callCodexAPI(String prompt, CommitMessageCallback callback) {
        try {
            CodexSDKBridge bridge = new CodexSDKBridge();

            // 创建简单的回调处理
            StringBuilder result = new StringBuilder();

            // CodexSDKBridge.sendMessage 需要 10 个参数：
            // (channelId, message, threadId, cwd, attachments, permissionMode, model, agentPrompt, reasoningEffort, callback)
            bridge.sendMessage(
                "git-commit-message",      // channelId
                prompt,                     // message
                null,                       // threadId (null 表示新会话)
                project.getBasePath(),      // cwd
                null,                       // attachments (不需要附件)
                null,                       // permissionMode (使用默认)
                null,                       // model (使用默认)
                null,                       // agentPrompt (不需要)
                null,                       // reasoningEffort (使用默认)
                new MessageCallback() {
                    @Override
                    public void onMessage(String type, String content) {
                        // 只收集 assistant 类型的内容，忽略 thinking/reasoning
                        if ("content".equals(type) || "assistant".equals(type) || "text".equals(type)) {
                            // 检查是否是思考过程
                            if (!isThinkingContent(content)) {
                                result.append(content);
                            }
                        }
                    }

                    @Override
                    public void onError(String error) {
                        callback.onError(error);
                    }

                    @Override
                    public void onComplete(SDKResult sdkResult) {
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
            LOG.error("Failed to call Codex API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    /**
     * 清理并提取 commit message
     * 优先从 XML 标签中提取，支持多种格式作为 fallback
     */
    private String cleanupCommitMessage(String message) {
        if (message == null || message.isEmpty()) {
            return "";
        }

        String cleaned = message;

        // 0. 先移除思考过程标记（如 "思考 ▸" 等）
        cleaned = removeThinkingMarkers(cleaned);

        // 1. 优先尝试从 <commit>...</commit> 标签中提取
        int startIdx = cleaned.indexOf(COMMIT_TAG_START);
        int endIdx = cleaned.indexOf(COMMIT_TAG_END);

        if (startIdx != -1 && endIdx != -1 && endIdx > startIdx) {
            cleaned = cleaned.substring(startIdx + COMMIT_TAG_START.length(), endIdx);
            // 将字面的 \n 转换为真正的换行符
            return convertLiteralNewlines(cleaned.trim());
        }

        // 2. Fallback: 尝试从 markdown 代码块中提取
        // 匹配 ```commit 或 ``` 开头的代码块
        if (cleaned.contains("```")) {
            int codeBlockStart = cleaned.indexOf("```");
            // 找到代码块开始后的第一个换行
            int contentStart = cleaned.indexOf('\n', codeBlockStart);
            if (contentStart != -1) {
                int codeBlockEnd = cleaned.indexOf("```", contentStart);
                if (codeBlockEnd != -1) {
                    cleaned = cleaned.substring(contentStart + 1, codeBlockEnd);
                    return convertLiteralNewlines(cleaned.trim());
                }
            }
        }

        // 3. Fallback: 尝试提取第一个符合 conventional commit 格式的行
        // 格式: type(scope): description 或 type: description
        String[] lines = cleaned.split("\n");
        for (String line : lines) {
            String trimmedLine = line.trim();
            if (isConventionalCommitLine(trimmedLine)) {
                // 找到第一行后，继续收集后续的 body 内容（直到遇到分析说明等无关内容）
                StringBuilder result = new StringBuilder(trimmedLine);
                int idx = java.util.Arrays.asList(lines).indexOf(line);
                boolean inBody = false;

                for (int i = idx + 1; i < lines.length; i++) {
                    String nextLine = lines[i].trim();
                    // 遇到分析说明、变更特征等关键词时停止
                    if (isAnalysisSection(nextLine)) {
                        break;
                    }
                    // 空行表示 body 开始
                    if (nextLine.isEmpty()) {
                        inBody = true;
                        result.append("\n");
                        continue;
                    }
                    // 在 body 中收集内容
                    if (inBody && !nextLine.startsWith("#") && !nextLine.startsWith("*")) {
                        result.append("\n").append(nextLine);
                    } else if (!inBody) {
                        // 如果还没到 body 但遇到非空行，说明是单行 commit
                        break;
                    }
                }
                return convertLiteralNewlines(result.toString().trim());
            }
        }

        // 4. 最后的 fallback: 返回原始内容的前几行（排除明显的分析内容）
        StringBuilder fallback = new StringBuilder();
        for (String line : lines) {
            String trimmedLine = line.trim();
            if (isAnalysisSection(trimmedLine)) {
                break;
            }
            if (!trimmedLine.isEmpty()) {
                fallback.append(trimmedLine).append("\n");
            }
            // 最多取 5 行
            if (fallback.toString().split("\n").length >= 5) {
                break;
            }
        }

        return convertLiteralNewlines(fallback.toString().trim());
    }

    /**
     * 将字面的 \n 转换为真正的换行符，并清理多余的空行
     */
    private String convertLiteralNewlines(String text) {
        if (text == null) {
            return null;
        }
        // 将字面的 \n (两个字符) 转换为真正的换行符
        String result = text.replace("\\n", "\n");

        // 移除开头的空行
        result = result.replaceFirst("^\\n+", "");

        // 将连续的多个空行替换为单个空行（保留 conventional commit 的标题和 body 之间的单个空行）
        result = result.replaceAll("\\n{3,}", "\n\n");

        return result.trim();
    }

    /**
     * 检查是否是 conventional commit 格式的行
     */
    private boolean isConventionalCommitLine(String line) {
        if (line == null || line.isEmpty()) {
            return false;
        }
        // 匹配: feat:, fix:, refactor:, feat(scope):, etc.
        String[] types = {"feat", "fix", "refactor", "docs", "test", "chore", "perf", "ci", "style", "build"};
        for (String type : types) {
            if (line.startsWith(type + ":") || line.startsWith(type + "(")) {
                return true;
            }
        }
        return false;
    }

    /**
     * 检查是否是分析说明部分（需要排除的内容）
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
        // 检查是否是数字列表开头（如 "1. xxx"）
        if (line.matches("^\\d+\\.\\s+.*")) {
            return true;
        }
        return false;
    }

    /**
     * 检查内容是否是思考过程
     */
    private boolean isThinkingContent(String content) {
        if (content == null || content.isEmpty()) {
            return false;
        }
        // 思考过程的常见标记
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
     * 移除思考过程标记和内容
     */
    private String removeThinkingMarkers(String content) {
        if (content == null || content.isEmpty()) {
            return content;
        }

        String result = content;

        // 移除 <thinking>...</thinking> 标签及其内容
        while (result.contains("<thinking>") && result.contains("</thinking>")) {
            int start = result.indexOf("<thinking>");
            int end = result.indexOf("</thinking>") + "</thinking>".length();
            if (start < end) {
                result = result.substring(0, start) + result.substring(end);
            } else {
                break;
            }
        }

        // 移除 "思考 ▸" 等 UI 标记
        String[] uiMarkers = {"思考 ▸", "思考▸", "思考 ►", "思考►", "Thinking ▸", "Thinking▸"};
        for (String marker : uiMarkers) {
            result = result.replace(marker, "");
        }

        // 移除开头的空行
        result = result.replaceFirst("^\\s*\\n+", "");

        return result.trim();
    }
}
