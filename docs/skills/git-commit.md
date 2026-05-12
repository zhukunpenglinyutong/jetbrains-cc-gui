---
name: git-commit
description: Generate exactly one commitlint-compatible Conventional Commits message from a selected git diff. Use for AI Commit Message Generator commit message style, with Chinese or English output.
---

# Commitlint-Compatible Commit Message Rules

## Goal

Generate exactly one commit message from the provided diff only. Follow Conventional Commits and the common `@commitlint/config-conventional` type set. The body should explain why the change exists, what problem it solves, or what impact it has, not restate the diff line by line. Do not infer unrelated changes. Do not run commands, edit files, commit, or push.

## Format

Use this format:

```text
type(scope): subject

body
```

- Always include `type`, `scope`, and `subject`.
- Keep `type` lowercase and in English.
- Use lowercase kebab-case for `scope`.
- Keep the full header within 100 characters when possible.
- Do not end `subject` with a period.
- Do not use emoji, signatures, Co-Authored-By lines, issue footers, or explanatory notes outside the commit message.
- Always include a body. For single-file trivial changes, one concise bullet is enough. For larger diffs, scale the body to the size of the change.
- For medium diffs, use 3-6 grouped bullets. For large diffs (10+ files or several subsystems), use 6-8 grouped bullets. For very large diffs (20+ files), use 7-10 grouped bullets unless the diff is almost entirely the same mechanical change repeated across files.
- Do not write one bullet per file, class, or field unless that item is the reason for the change.
- Cover each major functional area touched by the diff, especially new services, settings, UI behavior, tests, provider changes, and migration or fallback paths. Large commits should not collapse unrelated areas into one broad bullet.
- Separate body from header with one blank line.
- Prefer a `- ` bullet list for body content. Each bullet should describe one change, but the emphasis should be on why it matters.
- Keep body bullets concise and within 100 characters when practical.
- Do not use vague bullets such as "improve user experience" unless the exact behavior is named.
- Use exact nouns from the diff only when they help explain the behavior, impact, or failure mode.
- When the diff changes numeric values (thresholds, timeouts, limits, sizes), mention both old and new values.
- Mention specific methods, classes, or fields only when they are needed to explain the reason or impact.
- If the diff changes behavior, mention the user-visible behavior or failure mode in at least one body bullet.
- Do not mirror the diff as a checklist; the diff already shows what changed.
- Keep the style stable across different models.
- Prefer one header plus enough grouped bullets to represent the major work; do not add commentary outside the commit message.

## Type Set

Use only these commitlint conventional types:

- `build`: build system, packaging, generated distribution, dependencies
- `chore`: maintenance that does not fit another type
- `ci`: CI/CD configuration
- `docs`: documentation or comments only
- `feat`: new user-visible behavior, capability, provider, setting, or configuration
- `fix`: bug fix, broken behavior, compatibility fix, or incorrect UI state
- `perf`: performance improvement
- `refactor`: behavior-preserving code restructuring
- `revert`: revert a previous change
- `style`: formatting only, no behavior change
- `test`: tests

## Scope

Prefer a functional scope over a file name, class name, or raw path. For this plugin, prefer:

- `commit`: commit message generation, diff collection, prompt assembly, output cleanup
- `provider`: Claude/Codex provider resolution, local config discovery, HTTP calls
- `settings`: persisted settings or configuration form behavior
- `skill`: Skill scanning, filtering, built-in rules, Skill prompt behavior
- `ui`: visible labels, icons, loading states, user interaction
- `packaging`: plugin metadata, plugin icons, compatibility, distribution archives
- `docs`: README or user-facing documentation

Avoid class names, method names, raw paths, and vague scopes like `core` unless no clearer scope exists.

## Body Detail

When adding a body, make the bullets precise enough for a reviewer to understand the change without
opening the diff. Prefer bullets grouped by functional area, reason, or impact, not by file or symbol.
For large diffs, it is acceptable to name key classes, services, settings, and tests when that helps
the reviewer see the main work, as long as each bullet still represents a meaningful area instead of
a single-file inventory:

1. Why the change was needed.
2. What behavior or risk it affects.
3. The main implementation areas involved, named concretely when useful.
4. Any intentional fallback, migration, tests, or limitation.

Good body bullets:

- `- Add CommitSkillResolver so Skill mode can load builtin and project git-commit rules`
- `- Route commit generation through CommitHttpAiClient to support streaming and retry fallback`
- `- Filter sensitive paths from collected diffs to reduce credential leakage during generation`
- `- Persist the UI language so auto language mode follows the visible interface`
- `- Cover commit HTTP, cleanup, settings, and language sync behavior with focused tests`

Weak body bullets:

- `- List added classes and fields`
- `- Improve generation logic`
- `- Adjust code`

## Breaking Changes

Only include `!` after the type/scope or a `BREAKING CHANGE:` footer when the diff clearly introduces a breaking API or configuration change. Do not invent breaking changes.

## Language

Strictly follow the configured commit message language:

- Write `subject` and body in the configured language.
- For Simplified Chinese, write `subject` and body in concise Simplified Chinese.
- For English, use imperative present tense.
- For other languages, use the configured language for `subject` and body.
- Always keep `type(scope):` in English Conventional Commits syntax.
- Do not fall back to English unless English is the configured language.

## Decision Rules

- If the diff mixes unrelated purposes, choose the dominant purpose and generate one message only.
- If the diff only changes README, docs, or comments, use `docs`.
- If the diff changes plugin metadata, icons, compatibility, or distribution packaging, use `build` or `packaging` scope as appropriate.
- If the diff adds user-visible settings, provider support, Skill behavior, or new capabilities, use `feat`.
- If the diff fixes broken UI state, parsing, provider resolution, compatibility, or generated output, use `fix`.

## Examples

```text
feat(settings): 增加中英双语配置界面
```

```text
feat(commit): stream generated commit messages

- Add SSE parsing for Claude and Codex/OpenAI providers
- Throttle Commit Message input updates during generation
- Clean the full response after streaming completes
- Keep non-streaming generation as the provider fallback
```

```text
fix(commit): 恢复生成完成后的工具栏图标

- 在生成成功、失败和超时路径统一恢复静态 action 图标
- 在 update 阶段对非运行状态重新设置默认图标
- 避免按钮在生成完成后继续显示加载动画
```

```text
feat(skill): 内置默认提交信息规范

- 未选择本地 Skill 时从资源目录加载内置 git-commit 规范
- 按 commitlint conventional type 集合限制提交类型
- 使用列表式 body 描述关键改动和影响范围
```
