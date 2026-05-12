package com.github.claudecodegui.service;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.skill.CommitSkillResolver;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.CodexProviderManager;
import com.github.claudecodegui.util.LanguageConfigService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.FilePath;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangesUtil;
import com.intellij.openapi.vcs.changes.ContentRevision;
import com.intellij.openapi.vcs.VcsException;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.util.Collection;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Git commit message generation service.
 * Responsible for generating AI-powered commit messages.
 */
public class GitCommitMessageService {

    private static final Logger LOG = Logger.getInstance(GitCommitMessageService.class);

    private static final int MAX_DIFF_LENGTH = 4000; // Limit diff length to avoid exceeding token limits
    private static final String PROVIDER_CLAUDE = "claude";
    private static final String PROVIDER_CODEX = "codex";
    private static final String COMMIT_GENERATION_MODE_KEY = "generationMode";
    private static final String COMMIT_GENERATION_MODE_SKILL = "skill";
    private static final String COMMIT_SKILL_REF_KEY = "skillRef";
    private static final String COMMIT_LANGUAGE_KEY = "language";
    private static final String COMMIT_LANGUAGE_AUTO = "auto";

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
- 语言必须遵循本次请求中的 Commit language 配置

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
- 解释**为什么**变更、解决了什么问题、带来了什么影响（而不是逐行复述 diff）
- 使用少量项目符号按意图或影响分组
- 包含变更的动机和用户可见影响
- 只有在必要时才提及具体类、字段、方法或文件名
- 引用相关问题、约束或决策
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
- 使用正文解释为什么要改、影响了什么（而不是逐项罗列改动）
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

    /**
     * Commit message generation callback interface.
     */
    public interface CommitMessageCallback {
        void onSuccess(String commitMessage);
        void onError(String error);
        default void onPartial(String commitMessage) {
        }
    }

    public GitCommitMessageService(@NotNull Project project) {
        this.project = project;
        this.settingsService = new CodemossSettingsService();
    }

    /**
     * Generate a commit message.
     *
     * @param changes  The selected file changes
     * @param callback The callback interface
     */
    public void generateCommitMessage(
            @NotNull Collection<Change> changes,
            @NotNull CommitMessageCallback callback
    ) {
        try {
            long startedAt = System.nanoTime();
            LOG.info("Starting commit message generation for " + changes.size() + " change(s)");

            JsonObject commitAiConfig = getCommitAiConfig();
            boolean skillMode = COMMIT_GENERATION_MODE_SKILL.equals(getResolvedCommitGenerationMode(commitAiConfig));

            // 1. Generate git diff
            String diff = skillMode ? generateSkillGitDiff(changes) : generateGitDiff(changes);
            if (diff.isEmpty()) {
                callback.onError(ClaudeCodeGuiBundle.message("commit.noChangesFound"));
                return;
            }
            LOG.info("Git diff generated in " + elapsedMillis(startedAt) + " ms, length=" + diff.length());

            // 2. Build the full prompt (built-in prompt or selected Skill + diff)
            String fullPrompt = buildPromptForMode(diff, commitAiConfig);
            LOG.info("Commit prompt built in " + elapsedMillis(startedAt) + " ms, mode="
                    + getResolvedCommitGenerationMode(commitAiConfig)
                    + ", provider=" + getResolvedCommitAiProvider(commitAiConfig)
                    + ", language=" + getResolvedCommitLanguage(commitAiConfig)
                    + ", promptLength=" + fullPrompt.length());

            // 3. Call the AI SDK
            callAIService(fullPrompt, commitAiConfig, callback);

        } catch (IOException e) {
            LOG.warn("AI service call failed", e);
            String message = e.getMessage();
            callback.onError("AI service call failed: " + (message != null ? message : e.getClass().getSimpleName()));
        } catch (Exception e) {
            LOG.error("Failed to generate commit message", e);
            String message = e.getMessage();
            callback.onError(message != null ? message : e.getClass().getSimpleName());
        }
    }

    protected String generateSkillGitDiff(@NotNull Collection<Change> changes) {
        return new CommitSkillDiffCollector().collect(changes);
    }

    /**
     * Generate git diff.
     */
    protected String generateGitDiff(@NotNull Collection<Change> changes) {
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
     * Get the project-level additional prompt (optional).
     */
    private String getProjectAdditionalPrompt() {
        try {
            if (project == null) {
                return "";
            }
            String projectPath = project.getBasePath();
            if (null == projectPath) {
                return "";
            }
            String projectPrompt = settingsService.getProjectCommitPrompt(projectPath);
            if (null == projectPrompt || projectPrompt.trim().isEmpty()) {
                return "";
            }
            return projectPrompt.trim();
        } catch (Exception e) {
            LOG.warn("get project additional prompt fail:", e);
            return "";
        }
    }

    /**
     * Build the full prompt from either the legacy built-in prompt or the selected commit Skill.
     */
    private String buildPromptForMode(String diff, JsonObject commitAiConfig) {
        if (commitAiConfig == null) {
            return buildPromptWithBase(BUILTIN_COMMIT_PROMPT, diff, COMMIT_LANGUAGE_AUTO);
        }
        String mode = getResolvedCommitGenerationMode(commitAiConfig);
        String language = getResolvedCommitLanguage(commitAiConfig);
        if (COMMIT_GENERATION_MODE_SKILL.equals(mode)) {
            String skillRef = getResolvedCommitSkillRef(commitAiConfig);
            String skillContent = CommitSkillResolver.resolveSkillContent(
                    skillRef, project == null ? null : project.getBasePath());
            if (skillContent == null || skillContent.trim().isEmpty()) {
                LOG.warn("Selected skill could not be loaded, falling back to built-in prompt: " + skillRef);
                skillContent = BUILTIN_COMMIT_PROMPT;
            }
            return buildSkillPrompt(skillRef, skillContent, diff, language);
        }
        return buildPromptWithBase(BUILTIN_COMMIT_PROMPT, diff, language);
    }

    private String buildPromptWithBase(String basePrompt, String diff, String language) {
        int fileCount = countDiffFiles(diff);
        StringBuilder prompt = new StringBuilder();

        // 1. Highest-priority language rules
        appendLanguagePreference(prompt, language);

        // 2. Base commit rules
        prompt.append("\n\n");
        prompt.append(basePrompt);

        // 3. User's global additional prompt (if any)
        String userAdditionalPrompt = getUserAdditionalPrompt();
        if (!userAdditionalPrompt.isEmpty()) {
            prompt.append("\n\n## 用户附加要求（优先遵循）\n\n");
            prompt.append("以下是用户的额外要求，请在生成 commit message 时优先考虑这些要求：\n\n");
            prompt.append(userAdditionalPrompt);
        }

        // 4. Project-level additional prompt (highest priority)
        String projectAdditionalPrompt = getProjectAdditionalPrompt();
        if (!projectAdditionalPrompt.isEmpty()) {
            prompt.append("\n\n## 项目专属要求\n\n");
            prompt.append("以下是当前项目的专属要求，与上述用户附加要求同时生效。当两者矛盾时，以此处项目要求为准：\n\n");
            prompt.append(projectAdditionalPrompt);
        }

        // Repeat near the diff/output request so smaller models do not drift back to English.
        appendLanguagePreference(prompt, language);
        prompt.append("- Group related changes by intent or impact; do not write one bullet per file, class, or field.\n");
        prompt.append("- Cover each major functional area touched by the diff so large commits are still understandable.\n");
        prompt.append("- Explain why the change exists, what problem it solves, or what behavior it preserves.\n");
        prompt.append("- Mention specific methods, classes, and fields only when they help explain the reason or impact.\n");
        prompt.append("- Use precise '- ' bullets that explain why the change matters, not a line-by-line recap of the diff.\n");
        appendBodyScalePreference(prompt, fileCount);

        // 5. Git diff content
        prompt.append("\n\n---\n\n");
        prompt.append("以下是 git diff 信息，请根据以上规则生成 commit message：\n\n");
        prompt.append("```diff\n");
        prompt.append(diff);
        prompt.append("\n```");

        // 4. Output format requirements (enforce XML tag wrapping for easy parsing)
        prompt.append("\n\n【输出格式要求 - 必须严格遵守】\n");
        prompt.append("请将 commit message 用 XML 标签包裹输出，格式如下：\n");
        prompt.append("<commit>\n");
        prompt.append(exampleHeader(language)).append("\n");
        prompt.append("\n");
        prompt.append(exampleBody(language)).append("\n");
        prompt.append("</commit>\n\n");
        prompt.append("重要规则：\n");
        prompt.append("1. 必须使用 <commit> 和 </commit> 标签包裹\n");
        prompt.append("2. 标签外不要有任何其他内容（不要分析、不要解释、不要说明）\n");
        prompt.append("3. ").append(resolveCommitLanguageInstruction(language)).append("\n");

        return prompt.toString();
    }

    private String buildSkillPrompt(String skillRef, String skillContent, String diff, String language) {
        int fileCount = countDiffFiles(diff);

        StringBuilder prompt = new StringBuilder();
        prompt.append("## Required commit message language\n");
        prompt.append(resolveCommitLanguageInstruction(language)).append("\n");
        prompt.append("This language requirement overrides Skill text, examples, and any default-language wording below.\n");
        prompt.append("Use examples only for structure; do not copy their language unless it matches the configured language.\n\n");
        if (CommitSkillResolver.BUILTIN_SKILL_REF.equals(skillRef)) {
            prompt.append("Use the following built-in Skill as commit message style and format rules.\n");
            prompt.append("Do not run commands, do not edit files, do not commit, and do not push.\n\n");
            prompt.append("## Built-in Skill: git-commit\n\n").append(skillContent.trim()).append("\n\n");
        } else {
            prompt.append("Use the following local Skill only as commit message style and format rules.\n");
            prompt.append("Do not run commands, do not edit files, do not commit, and do not push.\n\n");
            prompt.append("## Local Skill\n\n").append(skillContent.trim()).append("\n\n");
        }
        prompt.append("## User preferences\n");
        prompt.append("- ").append(resolveCommitLanguageInstruction(language)).append("\n");
        prompt.append("- Keep only the Conventional Commit type and scope in English, such as `fix(commit):`.\n");
        prompt.append("- Generate exactly one commit message.\n");
        prompt.append("- Use only the diff below. Do not infer unrelated changes.\n");
        prompt.append("- Group related changes by intent or impact; do not write one bullet per file, class, or field.\n");
        prompt.append("- Cover each major functional area touched by the diff so large commits are still understandable.\n");
        prompt.append("- Explain why the change exists, what problem it solves, or what behavior it preserves.\n");
        prompt.append("- When the diff changes numeric values (thresholds, timeouts, limits, sizes), mention both old and new values.\n");
        prompt.append("- Mention specific methods, classes, and fields only when they help explain the reason or impact.\n");
        prompt.append("- Do NOT use generic body bullets such as \"improve logic\" or \"optimize experience\".\n");
        prompt.append("- Mention user-visible behavior, failure modes, compatibility, or settings impact when relevant.\n");
        prompt.append("- Use precise '- ' bullets that explain why the change matters, not a line-by-line recap of the diff.\n");
        prompt.append("- Keep the tone and structure consistent across models.\n");
        appendBodyScalePreference(prompt, fileCount);
        prompt.append("- Output only the final commit message wrapped in <commit> and </commit> tags.\n\n");
        prompt.append("## Selected git diff\n\n```diff\n");
        prompt.append(diff);
        prompt.append("\n```\n\n");
        prompt.append("Return format:\n<commit>\n")
                .append(exampleHeader(language))
                .append("\n\n")
                .append(exampleBody(language))
                .append("\n</commit>\n");
        return prompt.toString();
    }

    private void appendBodyScalePreference(StringBuilder prompt, int fileCount) {
        if (fileCount >= 20) {
            prompt.append("- IMPORTANT: This diff contains ").append(fileCount).append(" files. ");
            prompt.append("Write 7-10 grouped body bullets; do not write fewer than 7 unless the diff is ");
            prompt.append("almost entirely the same mechanical change repeated across files.\n");
            prompt.append("- For large diffs, name the main services, settings, UI flows, provider paths, ");
            prompt.append("tests, and fallback behavior when they are meaningful, while still grouping related files together.\n");
        } else if (fileCount >= 10) {
            prompt.append("- IMPORTANT: This diff contains ").append(fileCount).append(" files. ");
            prompt.append("Write 6-8 grouped body bullets covering the major functional areas.\n");
        } else if (fileCount >= 2) {
            prompt.append("- IMPORTANT: This diff contains ").append(fileCount).append(" files. ");
            prompt.append("Write 3-6 grouped body bullets as needed; do not compress unrelated areas into one vague bullet.\n");
        }
    }

    private void appendLanguagePreference(StringBuilder prompt, String language) {
        prompt.append("\n\n## Commit language\n");
        prompt.append(resolveCommitLanguageInstruction(language)).append("\n");
        prompt.append("Keep only the Conventional Commit type and scope in English, such as `fix(commit):`.\n");
        prompt.append("Keep the tone and wording natural for that language.\n");
        prompt.append("This overrides any examples, built-in defaults, or Skill text that mention another language.\n");
    }

    private int countDiffFiles(String diff) {
        if (diff == null || diff.isEmpty()) {
            return 0;
        }
        int count = 0;
        for (String marker : new String[]{"=== MODIFICATION: ", "=== NEW: ", "=== DELETED: ", "=== MOVED: "}) {
            int idx = 0;
            while ((idx = diff.indexOf(marker, idx)) >= 0) {
                count++;
                idx += marker.length();
            }
        }
        if (count > 0) {
            return count;
        }
        int idx = 0;
        while ((idx = diff.indexOf("diff --git ", idx)) >= 0) {
            count++;
            idx += 11;
        }
        return count;
    }

    /**
     * Call the AI service.
     */
    private void callAIService(String prompt, JsonObject commitAiConfig, CommitMessageCallback callback) throws IOException {
        String effectiveProvider = getResolvedCommitAiProvider(commitAiConfig);
        String effectiveModel = getResolvedCommitAiModel(commitAiConfig, effectiveProvider);
        String language = getResolvedCommitLanguage(commitAiConfig);
        String generationMode = getResolvedCommitGenerationMode(commitAiConfig);
        LOG.info("Commit AI routing: provider=" + effectiveProvider
                + ", model=" + effectiveModel
                + ", mode=" + generationMode
                + ", language=" + language);

        if (effectiveProvider == null) {
            callback.onError(ClaudeCodeGuiBundle.message("commit.noAvailableProvider"));
            return;
        }

        if (PROVIDER_CODEX.equals(effectiveProvider)) {
            callCodexAPI(prompt, getResolvedCommitAiModel(commitAiConfig, PROVIDER_CODEX), callback);
            return;
        }

        callClaudeAPI(prompt, getResolvedCommitAiModel(commitAiConfig, PROVIDER_CLAUDE), callback);
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

    private String getResolvedCommitGenerationMode(JsonObject commitAiConfig) {
        if (commitAiConfig == null
                || !commitAiConfig.has(COMMIT_GENERATION_MODE_KEY)
                || commitAiConfig.get(COMMIT_GENERATION_MODE_KEY).isJsonNull()) {
            return "prompt";
        }
        String mode = commitAiConfig.get(COMMIT_GENERATION_MODE_KEY).getAsString().trim().toLowerCase();
        return COMMIT_GENERATION_MODE_SKILL.equals(mode) ? COMMIT_GENERATION_MODE_SKILL : "prompt";
    }

    private String getResolvedCommitSkillRef(JsonObject commitAiConfig) {
        if (commitAiConfig == null
                || !commitAiConfig.has(COMMIT_SKILL_REF_KEY)
                || commitAiConfig.get(COMMIT_SKILL_REF_KEY).isJsonNull()) {
            return CommitSkillResolver.BUILTIN_SKILL_REF;
        }
        String skillRef = commitAiConfig.get(COMMIT_SKILL_REF_KEY).getAsString().trim();
        return skillRef.isEmpty() ? CommitSkillResolver.BUILTIN_SKILL_REF : skillRef;
    }

    private String getResolvedCommitLanguage(JsonObject commitAiConfig) {
        if (commitAiConfig == null
                || !commitAiConfig.has(COMMIT_LANGUAGE_KEY)
                || commitAiConfig.get(COMMIT_LANGUAGE_KEY).isJsonNull()) {
            return COMMIT_LANGUAGE_AUTO;
        }
        String language = commitAiConfig.get(COMMIT_LANGUAGE_KEY).getAsString().trim();
        return language.isEmpty() ? COMMIT_LANGUAGE_AUTO : language;
    }

    private String resolveCommitLanguageLabel(String language) {
        String normalized = language == null ? COMMIT_LANGUAGE_AUTO : language.trim();
        if (normalized.isEmpty() || COMMIT_LANGUAGE_AUTO.equalsIgnoreCase(normalized)) {
            normalized = LanguageConfigService.getCurrentLanguage();
        }
        return switch (normalized) {
            case "zh" -> "Simplified Chinese";
            case "zh-TW" -> "Traditional Chinese";
            case "ko" -> "Korean";
            case "ja" -> "Japanese";
            case "es" -> "Spanish";
            case "fr" -> "French";
            case "hi" -> "Hindi";
            case "ru" -> "Russian";
            case "pt-BR" -> "Brazilian Portuguese";
            case "en" -> "English";
            default -> "English";
        };
    }

    private String resolveCommitLanguageNativeLabel(String language) {
        String normalized = normalizeCommitLanguageForPrompt(language);
        return switch (normalized) {
            case "zh" -> "简体中文";
            case "zh-TW" -> "繁體中文";
            case "ko" -> "한국어";
            case "ja" -> "日本語";
            case "es" -> "Español";
            case "fr" -> "Français";
            case "hi" -> "हिन्दी";
            case "ru" -> "Русский";
            case "pt-BR" -> "Português (Brasil)";
            case "en" -> "English";
            default -> "English";
        };
    }

    private String resolveCommitLanguageInstruction(String language) {
        String normalized = normalizeCommitLanguageForPrompt(language);
        String englishLabel = resolveCommitLanguageLabel(normalized);
        String nativeLabel = resolveCommitLanguageNativeLabel(normalized);
        return "The final commit message subject and body MUST be written in "
                + englishLabel + " (" + nativeLabel + ").";
    }

    private String normalizeCommitLanguageForPrompt(String language) {
        String normalized = language == null ? COMMIT_LANGUAGE_AUTO : language.trim();
        if (normalized.isEmpty() || COMMIT_LANGUAGE_AUTO.equalsIgnoreCase(normalized)) {
            normalized = LanguageConfigService.getCurrentLanguage();
        }
        return normalized;
    }

    private String exampleHeader(String language) {
        return switch (normalizeCommitLanguageForPrompt(language)) {
            case "zh" -> "fix(commit): 修复提交信息语言配置";
            case "zh-TW" -> "fix(commit): 修復提交資訊語言設定";
            case "ko" -> "fix(commit): 커밋 메시지 언어 설정 수정";
            case "ja" -> "fix(commit): コミットメッセージの言語設定を修正";
            case "es" -> "fix(commit): corrige la configuración de idioma del commit";
            case "fr" -> "fix(commit): corrige la configuration de langue du commit";
            case "hi" -> "fix(commit): कमिट संदेश भाषा सेटिंग ठीक करें";
            case "ru" -> "fix(commit): исправить настройку языка коммита";
            case "pt-BR" -> "fix(commit): corrige a configuração de idioma do commit";
            default -> "fix(commit): fix commit message language setting";
        };
    }

    private String exampleBody(String language) {
        return switch (normalizeCommitLanguageForPrompt(language)) {
            case "zh" -> "- 按选择的语言生成提交信息标题和正文";
            case "zh-TW" -> "- 依照選取的語言生成提交資訊標題與正文";
            case "ko" -> "- 선택한 언어로 커밋 메시지 제목과 본문을 생성";
            case "ja" -> "- 選択した言語でコミットメッセージの件名と本文を生成";
            case "es" -> "- Genera el asunto y el cuerpo del commit en el idioma seleccionado";
            case "fr" -> "- Génère le sujet et le corps du commit dans la langue choisie";
            case "hi" -> "- चुनी गई भाषा में कमिट संदेश का विषय और मुख्य भाग बनाएं";
            case "ru" -> "- Генерирует тему и тело коммита на выбранном языке";
            case "pt-BR" -> "- Gera o assunto e o corpo do commit no idioma selecionado";
            default -> "- Generate the commit subject and body in the selected language";
        };
    }

    private boolean appendStreamingText(StringBuilder result, String type, String content) {
        if (content == null || content.isEmpty()) {
            return false;
        }
        if ("assistant".equals(type) && looksLikeJson(content)) {
            return false;
        }
        if ("content".equals(type)
                || "assistant".equals(type)
                || "text".equals(type)
                || "content_delta".equals(type)) {
            if (!isThinkingContent(content)) {
                result.append(content);
                return true;
            }
        }
        return false;
    }

    private boolean looksLikeJson(String content) {
        String trimmed = content == null ? "" : content.trim();
        return trimmed.startsWith("{") || trimmed.startsWith("[");
    }

    private void handleSdkResult(SDKResult sdkResult, StringBuilder result, CommitMessageCallback callback) {
        if (sdkResult == null) {
            callback.onError(ClaudeCodeGuiBundle.message("commit.emptyMessage"));
            return;
        }
        String commitMessage = result.length() > 0
                ? result.toString().trim()
                : safeTrim(sdkResult.finalResult);
        if (commitMessage.isEmpty()) {
            if (sdkResult.error != null && !sdkResult.error.isBlank()) {
                callback.onError(sdkResult.error);
            } else {
                callback.onError(ClaudeCodeGuiBundle.message("commit.emptyMessage"));
            }
            return;
        }
        callback.onSuccess(new CommitMessageCleaner().clean(commitMessage));
    }

    private String safeTrim(String value) {
        return value == null ? "" : value.trim();
    }

    private long elapsedMillis(long startedAtNanos) {
        return (System.nanoTime() - startedAtNanos) / 1_000_000L;
    }

    /**
     * Call the Claude API.
     */
    protected void callClaudeAPI(String prompt, String model, CommitMessageCallback callback) {
        CommitHttpAiClient.Config httpConfig = resolveClaudeHttpConfig(model);
        if (httpConfig != null) {
            LOG.info("Commit AI routing to Claude HTTP path: source=" + httpConfig.source
                    + ", baseUrl=" + httpConfig.baseUrl
                    + ", model=" + httpConfig.model);
            callClaudeHttpAPI(prompt, httpConfig, callback);
            return;
        }

        LOG.info("Commit AI routing to Claude SDK bridge: model=" + model);
        ClaudeSDKBridge bridge = new ClaudeSDKBridge();
        try {
            // Simple callback handler
            StringBuilder result = new StringBuilder();
            AtomicBoolean completed = new AtomicBoolean(false);

            // Use the 12-parameter sendMessage overload:
            // - model: COMMIT_MESSAGE_MODEL (Sonnet model)
            // - streaming: false (non-streaming, returns complete result at once)
            // - disableThinking: true (disable thinking mode to avoid verbose reasoning output)
            CompletableFuture<SDKResult> future = bridge.sendMessage(
                "git-commit-message",      // channelId
                prompt,                     // message
                null,                       // sessionId (null = new session)
                project.getBasePath(),      // cwd
                null,                       // attachments (not needed)
                null,                       // permissionMode (use default)
                model,                      // model
                null,                       // openedFiles
                null,                       // agentPrompt
                true,                       // streaming (stream partial commit text)
                true,                       // disableThinking (disable thinking mode)
                new MessageCallback() {
                    @Override
                    public void onMessage(String type, String content) {
                        if (appendStreamingText(result, type, content)) {
                            callback.onPartial(new CommitMessageCleaner().cleanPartial(result.toString()));
                        }
                    }

                    @Override
                    public void onError(String error) {
                        if (completed.compareAndSet(false, true)) {
                            bridge.shutdownDaemon();
                            callback.onError(error);
                        }
                    }

                    @Override
                    public void onComplete(SDKResult sdkResult) {
                        if (completed.compareAndSet(false, true)) {
                            bridge.shutdownDaemon();
                            handleSdkResult(sdkResult, result, callback);
                        }
                    }
                }
            );
            try {
                SDKResult sdkResult = future.get();
                if (completed.compareAndSet(false, true)) {
                    bridge.shutdownDaemon();
                    handleSdkResult(sdkResult, result, callback);
                }
            } catch (InterruptedException e) {
                future.cancel(true);
                bridge.shutdownDaemon();
                Thread.currentThread().interrupt();
                callback.onError("Generation cancelled");
            } catch (ExecutionException e) {
                if (completed.compareAndSet(false, true)) {
                    bridge.shutdownDaemon();
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + cause.getMessage());
                }
            }
        } catch (Exception e) {
            bridge.shutdownDaemon();
            LOG.error("Failed to call Claude API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    /**
     * Call the Codex API.
     */
    protected void callCodexAPI(String prompt, String model, CommitMessageCallback callback) {
        CommitHttpAiClient.Config httpConfig = resolveCodexHttpConfig(model);
        if (httpConfig != null) {
            LOG.info("Commit AI routing to Codex HTTP path: source=" + httpConfig.source
                    + ", baseUrl=" + httpConfig.baseUrl
                    + ", model=" + httpConfig.model
                    + ", wireApi=" + httpConfig.wireApi);
            callCodexHttpAPI(prompt, httpConfig, callback);
            return;
        }

        LOG.info("Commit AI routing to Codex SDK bridge: model=" + model);
        CodexSDKBridge bridge = new CodexSDKBridge();
        try {
            // Simple callback handler
            StringBuilder result = new StringBuilder();
            AtomicBoolean completed = new AtomicBoolean(false);

            // CodexSDKBridge.sendMessage requires 10 parameters:
            // (channelId, message, threadId, cwd, attachments, permissionMode, model, agentPrompt, reasoningEffort, callback)
            CompletableFuture<SDKResult> future = bridge.sendMessage(
                "git-commit-message",      // channelId
                prompt,                     // message
                null,                       // threadId (null = new session)
                project.getBasePath(),      // cwd
                null,                       // attachments (not needed)
                null,                       // permissionMode (use default)
                model,                      // model
                null,                       // agentPrompt (not needed)
                null,                       // reasoningEffort (use default)
                new MessageCallback() {
                    @Override
                    public void onMessage(String type, String content) {
                        if (appendStreamingText(result, type, content)) {
                            callback.onPartial(new CommitMessageCleaner().cleanPartial(result.toString()));
                        }
                    }

                    @Override
                    public void onError(String error) {
                        if (completed.compareAndSet(false, true)) {
                            bridge.cleanupAllProcesses();
                            callback.onError(error);
                        }
                    }

                    @Override
                    public void onComplete(SDKResult sdkResult) {
                        if (completed.compareAndSet(false, true)) {
                            bridge.cleanupAllProcesses();
                            handleSdkResult(sdkResult, result, callback);
                        }
                    }
                }
            );
            try {
                SDKResult sdkResult = future.get();
                if (completed.compareAndSet(false, true)) {
                    bridge.cleanupAllProcesses();
                    handleSdkResult(sdkResult, result, callback);
                }
            } catch (InterruptedException e) {
                future.cancel(true);
                bridge.cleanupAllProcesses();
                Thread.currentThread().interrupt();
                callback.onError("Generation cancelled");
            } catch (ExecutionException e) {
                if (completed.compareAndSet(false, true)) {
                    bridge.cleanupAllProcesses();
                    Throwable cause = e.getCause() != null ? e.getCause() : e;
                    callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + cause.getMessage());
                }
            }
        } catch (Exception e) {
            bridge.cleanupAllProcesses();
            LOG.error("Failed to call Codex API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    private void callClaudeHttpAPI(String prompt, CommitHttpAiClient.Config httpConfig, CommitMessageCallback callback) {
        try {
            CommitMessageCleaner cleaner = new CommitMessageCleaner();
            StringBuilder result = new StringBuilder();
            String raw = new CommitHttpAiClient().generateClaude(prompt, httpConfig, chunk -> {
                if (chunk == null || chunk.isEmpty()) {
                    return;
                }
                result.append(chunk);
                callback.onPartial(cleaner.cleanPartial(result.toString()));
            });
            String commitMessage = result.length() > 0 ? result.toString().trim() : raw.trim();
            if (commitMessage.isEmpty()) {
                callback.onError(ClaudeCodeGuiBundle.message("commit.emptyMessage"));
                return;
            }
            callback.onSuccess(cleaner.clean(commitMessage));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            callback.onError("Generation cancelled");
        } catch (Exception e) {
            LOG.error("Failed to call Claude HTTP API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    private void callCodexHttpAPI(String prompt, CommitHttpAiClient.Config httpConfig, CommitMessageCallback callback) {
        try {
            CommitMessageCleaner cleaner = new CommitMessageCleaner();
            StringBuilder result = new StringBuilder();
            String raw = new CommitHttpAiClient().generateOpenAiCompatible(prompt, httpConfig, chunk -> {
                if (chunk == null || chunk.isEmpty()) {
                    return;
                }
                result.append(chunk);
                callback.onPartial(cleaner.cleanPartial(result.toString()));
            });
            String commitMessage = result.length() > 0 ? result.toString().trim() : raw.trim();
            if (commitMessage.isEmpty()) {
                callback.onError(ClaudeCodeGuiBundle.message("commit.emptyMessage"));
                return;
            }
            callback.onSuccess(cleaner.clean(commitMessage));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            callback.onError("Generation cancelled");
        } catch (Exception e) {
            LOG.error("Failed to call Codex HTTP API", e);
            callback.onError(ClaudeCodeGuiBundle.message("commit.callApiFailed") + ": " + e.getMessage());
        }
    }

    private CommitHttpAiClient.Config resolveClaudeHttpConfig(String model) {
        try {
            JsonObject activeProvider = settingsService.getActiveClaudeProvider();
            JsonObject env = new JsonObject();
            if (activeProvider != null && activeProvider.has("settingsConfig") && activeProvider.get("settingsConfig").isJsonObject()) {
                JsonObject settingsConfig = activeProvider.getAsJsonObject("settingsConfig");
                if (settingsConfig.has("env") && settingsConfig.get("env").isJsonObject()) {
                    env = settingsConfig.getAsJsonObject("env").deepCopy();
                }
            }
            JsonObject claudeSettings = settingsService.readClaudeSettings();
            if (claudeSettings.has("env") && claudeSettings.get("env").isJsonObject()) {
                JsonObject fileEnv = claudeSettings.getAsJsonObject("env");
                mergeEnv(env, fileEnv);
            }
            String apiKey = firstJson(env, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_API_KEY");
            String baseUrl = firstJson(env, "ANTHROPIC_BASE_URL", "CLAUDE_BASE_URL");
            if (apiKey == null || apiKey.isBlank()) {
                return null;
            }
            return new CommitHttpAiClient.Config(
                    apiKey.trim(),
                    baseUrl == null || baseUrl.isBlank() ? "https://api.anthropic.com" : baseUrl.trim(),
                    resolveClaudeModel(model, env),
                    "",
                    "claude-http"
            );
        } catch (Exception e) {
            LOG.debug("Failed to resolve Claude HTTP config: " + e.getMessage());
            return null;
        }
    }

    private CommitHttpAiClient.Config resolveCodexHttpConfig(String model) {
        try {
            JsonObject configRoot = null;
            JsonObject authJson = null;

            try {
                JsonObject currentCodexConfig = settingsService.getCurrentCodexConfig();
                if (currentCodexConfig != null && currentCodexConfig.size() > 0) {
                    if (currentCodexConfig.has("config") && currentCodexConfig.get("config").isJsonObject()) {
                        configRoot = currentCodexConfig.getAsJsonObject("config");
                    }
                    if (currentCodexConfig.has("auth") && currentCodexConfig.get("auth").isJsonObject()) {
                        authJson = currentCodexConfig.getAsJsonObject("auth");
                    }
                }
            } catch (Exception e) {
                LOG.debug("Failed to read current Codex config before provider fallback: " + e.getMessage());
            }

            JsonObject activeProvider = settingsService.getActiveCodexProvider();
            if ((configRoot == null || authJson == null)
                    && activeProvider != null
                    && !CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(getString(activeProvider, "id"))) {
                if (configRoot == null) {
                    configRoot = readCodexConfigToml(activeProvider);
                }
                if (authJson == null) {
                    authJson = readCodexAuthJson(activeProvider);
                }
            }

            if (configRoot == null || authJson == null) {
                JsonObject fallback = selectDirectCodexProvider();
                if (fallback != null) {
                    if (configRoot == null) {
                        configRoot = readCodexConfigToml(fallback);
                    }
                    if (authJson == null) {
                        authJson = readCodexAuthJson(fallback);
                    }
                }
            }

            if (configRoot == null) {
                return null;
            }

            String apiKey = firstJson(authJson, "OPENAI_API_KEY", "api_key", "apiKey");
            if (apiKey == null || apiKey.isBlank()) {
                apiKey = firstJson(configRoot, "OPENAI_API_KEY", "api_key", "apiKey");
            }
            String providerName = firstJson(configRoot, "model_provider");
            if (providerName == null || providerName.isBlank()) {
                providerName = firstModelProviderName(configRoot);
            }
            String resolvedModel = firstJson(configRoot, "model");
            String baseUrl = null;
            String wireApi = null;
            if (providerName != null && !providerName.isBlank()) {
                baseUrl = firstTomlValue(configRoot, "model_providers." + providerName + ".base_url",
                        "model_providers." + providerName + ".baseURL",
                        "model_providers." + providerName + ".openai_base_url");
                wireApi = firstTomlValue(configRoot, "model_providers." + providerName + ".wire_api",
                        "model_providers." + providerName + ".wireApi");
                if (apiKey == null || apiKey.isBlank()) {
                    String envKey = firstTomlValue(configRoot, "model_providers." + providerName + ".env_key",
                            "model_providers." + providerName + ".api_key_env",
                            "model_providers." + providerName + ".apiKeyEnv");
                    if (envKey != null && !envKey.isBlank()) {
                        apiKey = firstTomlValue(configRoot, "shell_environment_policy.set." + envKey,
                                "shell_environment_policy.set.OPENAI_API_KEY");
                        if (apiKey == null || apiKey.isBlank()) {
                            apiKey = System.getenv(envKey.trim());
                        }
                    }
                    if (apiKey == null || apiKey.isBlank()) {
                        apiKey = firstTomlValue(configRoot, "model_providers." + providerName + ".api_key",
                                "model_providers." + providerName + ".apiKey",
                                "model_providers." + providerName + ".OPENAI_API_KEY");
                    }
                }
                if (resolvedModel == null || resolvedModel.isBlank()) {
                    resolvedModel = firstTomlValue(configRoot, "model_providers." + providerName + ".model");
                }
            }
            if (model != null && !model.trim().isEmpty()) {
                resolvedModel = model.trim();
            }
            if (baseUrl == null || baseUrl.isBlank()) {
                baseUrl = firstJson(configRoot, "base_url", "baseURL", "openai_base_url", "OPENAI_BASE_URL", "OPENAI_API_BASE");
            }
            if (baseUrl == null || baseUrl.isBlank()) {
                baseUrl = "https://api.openai.com";
            }
            if ((apiKey == null || apiKey.isBlank()) && isLocalUrl(baseUrl)) {
                apiKey = "local-codex";
            }
            if (apiKey == null || apiKey.isBlank()) {
                return null;
            }
            return new CommitHttpAiClient.Config(
                    apiKey.trim(),
                    baseUrl.trim(),
                    resolvedModel == null ? "" : resolvedModel.trim(),
                    wireApi == null ? "" : wireApi.trim(),
                    "codex-http"
            );
        } catch (Exception e) {
            LOG.debug("Failed to resolve Codex HTTP config: " + e.getMessage());
            return null;
        }
    }

    private JsonObject selectDirectCodexProvider() {
        try {
            for (JsonObject provider : settingsService.getCodexProviders()) {
                String id = getString(provider, "id");
                if (CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(id)) {
                    continue;
                }
                if (readCodexConfigToml(provider) != null) {
                    return provider;
                }
            }
        } catch (Exception e) {
            LOG.debug("Failed to select direct Codex provider: " + e.getMessage());
        }
        return null;
    }

    private JsonObject readCodexConfigToml(JsonObject provider) {
        try {
            if (provider != null && provider.has("configToml") && provider.get("configToml").isJsonPrimitive()) {
                String configTomlContent = provider.get("configToml").getAsString();
                if (configTomlContent != null && !configTomlContent.trim().isEmpty()) {
                    return parseCodexToml(configTomlContent);
                }
            }
        } catch (Exception e) {
            LOG.debug("Failed to read Codex configToml: " + e.getMessage());
        }
        return null;
    }

    private JsonObject readCodexAuthJson(JsonObject provider) {
        try {
            if (provider != null && provider.has("authJson") && provider.get("authJson").isJsonPrimitive()) {
                String authJsonContent = provider.get("authJson").getAsString();
                if (authJsonContent != null && !authJsonContent.trim().isEmpty()) {
                    return JsonParser.parseString(authJsonContent).getAsJsonObject();
                }
            }
        } catch (Exception e) {
            LOG.debug("Failed to read Codex authJson: " + e.getMessage());
        }
        return null;
    }

    private String firstModelProviderName(JsonObject object) {
        if (object == null || !object.has("model_providers") || !object.get("model_providers").isJsonObject()) {
            return null;
        }
        JsonObject providers = object.getAsJsonObject("model_providers");
        for (Map.Entry<String, com.google.gson.JsonElement> entry : providers.entrySet()) {
            if (entry.getValue() != null && entry.getValue().isJsonObject()) {
                return entry.getKey();
            }
        }
        return null;
    }

    private void mergeEnv(JsonObject target, JsonObject source) {
        if (target == null || source == null) {
            return;
        }
        for (Map.Entry<String, com.google.gson.JsonElement> entry : source.entrySet()) {
            if (!entry.getValue().isJsonNull()) {
                target.add(entry.getKey(), entry.getValue());
            }
        }
    }

    private String firstJson(JsonObject object, String... keys) {
        if (object == null) {
            return null;
        }
        for (String key : keys) {
            if (object.has(key) && !object.get(key).isJsonNull()) {
                String value = object.get(key).getAsString();
                if (value != null && !value.trim().isEmpty()) {
                    return value.trim();
                }
            }
        }
        return null;
    }

    private String getString(JsonObject object, String key) {
        if (object == null || key == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        String value = object.get(key).getAsString();
        return value == null ? null : value.trim();
    }

    private String resolveClaudeModel(String explicitModel, JsonObject env) {
        if (explicitModel != null && !explicitModel.trim().isEmpty()) {
            return explicitModel.trim();
        }
        String model = firstJson(env, "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_SMALL_FAST_MODEL");
        return model == null || model.isBlank() ? "claude-sonnet-4-6" : model;
    }

    private JsonObject parseCodexToml(String content) {
        JsonObject result = new JsonObject();
        if (content == null || content.trim().isEmpty()) {
            return result;
        }
        JsonObject currentSection = result;
        for (String rawLine : content.split("\\R")) {
            String line = stripTomlComment(rawLine).trim();
            if (line.isEmpty()) {
                continue;
            }
            if (line.startsWith("[[") && line.endsWith("]]")) {
                currentSection = ensureTomlSection(result, unquoteTomlPath(line.substring(2, line.length() - 2).trim()));
                continue;
            }
            if (line.startsWith("[") && line.endsWith("]")) {
                currentSection = ensureTomlSection(result, unquoteTomlPath(line.substring(1, line.length() - 1).trim()));
                continue;
            }
            int equals = line.indexOf('=');
            if (equals <= 0) {
                continue;
            }
            String key = unquoteTomlValue(line.substring(0, equals).trim());
            String value = unquoteTomlValue(line.substring(equals + 1).trim());
            currentSection.addProperty(key, value);
        }
        return result;
    }

    private JsonObject ensureTomlSection(JsonObject root, String sectionPath) {
        JsonObject current = root;
        if (sectionPath == null || sectionPath.isBlank()) {
            return current;
        }
        for (String part : sectionPath.split("\\.")) {
            if (part.isBlank()) {
                continue;
            }
            if (!current.has(part) || !current.get(part).isJsonObject()) {
                current.add(part, new JsonObject());
            }
            current = current.getAsJsonObject(part);
        }
        return current;
    }

    private String firstTomlValue(JsonObject object, String... paths) {
        if (object == null) {
            return null;
        }
        for (String path : paths) {
            String value = readTomlValue(object, path);
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return null;
    }

    private String readTomlValue(JsonObject object, String path) {
        if (object == null || path == null || path.isBlank()) {
            return null;
        }
        JsonObject current = object;
        String[] parts = path.split("\\.");
        for (int i = 0; i < parts.length; i++) {
            String part = parts[i];
            if (i == parts.length - 1) {
                if (current.has(part) && !current.get(part).isJsonNull()) {
                    return current.get(part).getAsString();
                }
                return null;
            }
            if (!current.has(part) || !current.get(part).isJsonObject()) {
                return null;
            }
            current = current.getAsJsonObject(part);
        }
        return null;
    }

    private String stripTomlComment(String line) {
        boolean inSingle = false;
        boolean inDouble = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (c == '\'' && !inDouble) {
                inSingle = !inSingle;
            } else if (c == '"' && !inSingle) {
                inDouble = !inDouble;
            } else if (c == '#' && !inSingle && !inDouble) {
                return line.substring(0, i);
            }
        }
        return line;
    }

    private String unquoteTomlPath(String value) {
        StringBuilder out = new StringBuilder();
        StringBuilder part = new StringBuilder();
        boolean inSingle = false;
        boolean inDouble = false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '\'' && !inDouble) {
                inSingle = !inSingle;
                continue;
            }
            if (c == '"' && !inSingle) {
                inDouble = !inDouble;
                continue;
            }
            if (c == '.' && !inSingle && !inDouble) {
                appendTomlPathPart(out, part);
                continue;
            }
            part.append(c);
        }
        appendTomlPathPart(out, part);
        return out.toString();
    }

    private void appendTomlPathPart(StringBuilder out, StringBuilder part) {
        if (out.length() > 0) {
            out.append('.');
        }
        out.append(part.toString().trim());
        part.setLength(0);
    }

    private String unquoteTomlValue(String value) {
        String trimmed = value == null ? "" : value.trim();
        if ((trimmed.startsWith("\"") && trimmed.endsWith("\""))
                || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
            return trimmed.substring(1, trimmed.length() - 1);
        }
        return trimmed;
    }

    private boolean isLocalUrl(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase();
        return normalized.startsWith("http://127.0.0.1")
                || normalized.startsWith("http://localhost")
                || normalized.startsWith("http://[::1]");
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
}
