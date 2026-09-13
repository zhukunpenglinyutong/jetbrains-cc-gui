package com.github.claudecodegui.service.commit;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

/**
 * Assembles the full commit-message prompt.
 *
 * <p>Composition (lowest → highest priority):
 * <ol>
 *     <li>Built-in spec (Conventional Commits, kept short for low latency).</li>
 *     <li>User's global additional prompt (Settings → Commit).</li>
 *     <li>Project-level additional prompt (overrides the above on conflict).</li>
 *     <li>The git diff itself.</li>
 * </ol>
 *
 * <p>The built-in prompt is intentionally lean — every extra token adds TTFT
 * and cost on a feature that runs on every commit. The verbose guide that used
 * to live here was trimmed to the format spec + type table + output contract.
 */
public class CommitPromptBuilder {

    private static final Logger LOG = Logger.getInstance(CommitPromptBuilder.class);

    /**
     * Lean built-in commit spec. Users can append additional prompts via the
     * settings page, which take priority.
     */
    private static final String BUILTIN_COMMIT_PROMPT = """
            你是一名资深软件工程师，请基于下方 git diff 撰写一条高质量的 Git commit message，遵循 Conventional Commits 规范。

            输出格式：
            <type>[scope]: <description>

            <body>

            [footer]

            提交类型：feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert

            要求：
            - 主题行：祈使语气、现在时，不超过 72 字符，末尾不加句号。
            - 正文（当改动多于一个逻辑点时【必须】写）：总结【改了什么】和【为什么改】（不要逐行复述 diff）。把相关的改动归纳成要点，每条以 "- " 开头，并提及主要涉及的文件/模块/区域，让审查者不读 diff 也能把握这次提交。请写出有实质内容的正文，而不是只有一行主题。
            - 每行不超过 72 字符。
            - 页脚：如适用，写 BREAKING CHANGE 与 issue 引用（Closes: #123）。
            - 只输出 commit message 本身：不要前缀分析、不要解释、不要 "Generated with" / "Co-Authored-By"、不要 emoji。
            - 必须用 <commit></commit> 标签包裹整条消息，标签外不要有任何内容。
            """;

    private final CodemossSettingsService settingsService;
    private final Project project;

    public CommitPromptBuilder(@NotNull CodemossSettingsService settingsService, Project project) {
        this.settingsService = settingsService;
        this.project = project;
    }

    /**
     * Build the full prompt: built-in + user prompt + project prompt + diff.
     */
    @NotNull
    public String build(@NotNull String diff) {
        StringBuilder prompt = new StringBuilder();
        prompt.append(BUILTIN_COMMIT_PROMPT);

        String userAdditionalPrompt = getUserAdditionalPrompt();
        if (!userAdditionalPrompt.isEmpty()) {
            prompt.append("\n\n## 用户附加要求（优先遵循）\n\n");
            prompt.append("以下是用户的额外要求，请在生成 commit message 时优先考虑：\n\n");
            prompt.append(userAdditionalPrompt);
        }

        String projectAdditionalPrompt = getProjectAdditionalPrompt();
        if (!projectAdditionalPrompt.isEmpty()) {
            prompt.append("\n\n## 项目专属要求\n\n");
            prompt.append("以下是当前项目的专属要求，与上述用户附加要求同时生效。当两者矛盾时，以此处项目要求为准：\n\n");
            prompt.append(projectAdditionalPrompt);
        }

        prompt.append("\n\n---\n\n");
        prompt.append("以下是 git diff，请据此生成 commit message：\n\n");
        prompt.append("```diff\n");
        prompt.append(diff);
        prompt.append("\n```");

        prompt.append("\n\n【输出格式要求 - 必须严格遵守】\n");
        prompt.append("用 <commit> 和 </commit> 标签包裹 commit message，标签外不要有任何内容（不分析、不解释）。\n");

        return prompt.toString();
    }

    /** User's global additional prompt (optional; legacy default treated as unset). */
    @NotNull
    private String getUserAdditionalPrompt() {
        try {
            String userPrompt = settingsService.getCommitPrompt();
            if (userPrompt == null || userPrompt.trim().isEmpty()) {
                return "";
            }
            // Treat the old default value as not configured.
            if (userPrompt.equals("你是一个commit提交专员，请你阅读git记录，帮我生成commit记录")) {
                return "";
            }
            return userPrompt.trim();
        } catch (Exception e) {
            LOG.warn("Failed to get user additional prompt from settings", e);
            return "";
        }
    }

    /** Project-level additional prompt (optional, highest priority). */
    @NotNull
    private String getProjectAdditionalPrompt() {
        try {
            String projectPath = project == null ? null : project.getBasePath();
            if (projectPath == null) {
                return "";
            }
            String projectPrompt = settingsService.getProjectCommitPrompt(projectPath);
            if (projectPrompt == null || projectPrompt.trim().isEmpty()) {
                return "";
            }
            return projectPrompt.trim();
        } catch (Exception e) {
            LOG.warn("get project additional prompt fail:", e);
            return "";
        }
    }
}
