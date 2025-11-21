# 解决 Claude CLI 在 IDEA 插件中写入 `/tmp` 的问题

在 IDE 插件中调用 `claude-code` CLI 时，模型经常会把 `Write/Edit` 等工具的 `file_path` 指向 `/tmp/xxx`。如果直接将 CLI 入口点切换到 `claude-vscode`，虽然会沿用 VSCode 的“工作区信任”策略，但也会强制要求通过 `/login` 获取官方凭证，并且只支持官方 `https://api.anthropic.com`。对于使用自建网关或手动配置 `ANTHROPIC_API_KEY` 的场景，这条路不可行。

最终有效的方案有两部分：

## 1. 使用 `sdk-ts` 入口点并注入自有 API 凭证

1. 在 `claude-bridge/channel-manager.js` 中把入口点固定为 `sdk-ts`：

   ```java
   process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
   ```

2. 调用 CLI 前，从 `~/.claude/settings.json` 或环境变量读取 `ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL`，写入 `process.env`。这样 CLI 就不会提示 `/login`，自建 API 也能正常工作。

3. 仍然可以保留现有的 `cwd`/`TMPDIR` 设置与 `additionalDirectories`，便于调试和记录日志，但不再依赖 `WorkspaceTrustManager` 自动改写 `settings.json`。

## 2. 在 `permission-handler` 中重写工具的写入路径

1. 在 `claude-bridge/permission-handler.js` 的 `canUseTool` 里增加一段重写逻辑：当检测到工具输入中出现 `file_path` 且指向 `/tmp`、`/var/tmp` 等临时目录时，自动改写为当前工作区根 (`IDEA_PROJECT_PATH` 或 `PROJECT_PATH`) 下的同名文件。

   ```javascript
   rewriteToolInputPaths(toolName, input);
   ```

2. `rewriteToolInputPaths` 会递归检查 `input`，遇到 `/tmp/foo.js` 这类路径时将其换成 `path.join(workdir, "foo.js")`，并在日志中打印所有改写记录，方便验证。

3. 由于这一步发生在 CLI 真正执行工具之前，Claude 即使仍然生成 `/tmp/...` 也会被我们拦下，从而保证所有写入都落在项目目录内。

## 3. 验证方式

1. 在 IDE 中触发“创建文件”之类的工作流。
2. 观察插件日志，确认：
   - `CLAUDE_CODE_ENTRYPOINT` 为 `sdk-ts`；
   - `permission-handler` 输出了 `[PERMISSION] Rewrote paths ...`，说明临时路径被成功改写；
   - CLI `tool_use` 日志中仍可能出现 `/tmp/...`，但实际执行时使用的则是被改写后的路径。

通过这套方案，可以继续使用自管的 API/网关，并根除 CLI 在 IDEA 环境下写入 `/tmp` 的问题，同时避免依赖 VSCode 专用的认证流程。

