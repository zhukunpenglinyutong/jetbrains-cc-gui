# Windows 下 Claude CLI 路径问题

## 问题描述

在 Windows 环境下，插件启动时会报错：

```
process exited with code 1
```

日志显示 ENOENT 错误：

```
[Node.js] [DEBUG] Error in message loop: Failed to spawn Claude Code process: spawn D:\Apps\Scoop\apps\nvm\current\nodejs\nodejs\claude ENOENT
```

## 问题原因

### 1. `where claude` 命令返回的路径问题

在 Windows 上，`where claude` 命令会返回多个匹配结果：

```
D:\Apps\Scoop\apps\nvm\current\nodejs\nodejs\claude
D:\Apps\Scoop\apps\nvm\current\nodejs\nodejs\claude.cmd
```

原代码取第一个结果 `claude`（无扩展名），但这个路径：
- 在 Windows 上**不能直接被 `spawn()` 执行**
- 它实际上是一个 shim 文件，需要通过 `.cmd` 包装器来调用
- 直接 spawn 会导致 `ENOENT`（文件不存在）错误

### 2. SDK 的 spawn 机制

Claude Agent SDK 使用 Node.js 的 `child_process.spawn()` 来启动 CLI 进程。在 Windows 上：
- `.cmd` 文件可以通过 `shell: true` 选项执行
- 但无扩展名的 shim 文件无法直接执行

## 解决方案

**完全使用 SDK 内置的 cli.js，不再查找系统安装的 Claude CLI。**

SDK 内置了官方 CLI：
- 路径：`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`
- 这是 Anthropic 官方 Claude Code CLI 的 Node 版本
- 当不传递 `pathToClaudeCodeExecutable` 选项时，SDK 会自动使用它

### 修改内容

#### 1. `claude-bridge/services/message-service.js`

移除 `getClaudeCliPath` 相关代码：

```javascript
// 之前
import { mapModelIdToSdkName, getClaudeCliPath } from '../utils/model-utils.js';
const claudeCliPath = getClaudeCliPath();
const options = {
  // ...
  pathToClaudeCodeExecutable: claudeCliPath,
};

// 之后
import { mapModelIdToSdkName } from '../utils/model-utils.js';
const options = {
  // ...
  // 不传递 pathToClaudeCodeExecutable，SDK 将自动使用内置 cli.js
};
```

#### 2. `claude-bridge/utils/model-utils.js`

删除整个 `getClaudeCliPath()` 函数（约 60 行代码），包括：
- `where claude` / `which claude` 命令调用
- 常见路径检测逻辑
- 相关的 `fs` 和 `child_process` import

## 使用内置 CLI 的优点

1. **跨平台最稳定**：不依赖 `where`/`which` 等平台相关命令
2. **版本对齐**：CLI 版本与 SDK 完全一致，避免兼容性问题
3. **自定义 Base URL 仍然有效**：SDK 会继承 `process.env` 中的 `ANTHROPIC_BASE_URL`
4. **配置来源一致**：内置 CLI 同样读取 `~/.claude/settings.json`

## 注意事项

- 如果将来需要支持"使用系统 CLI"的高级选项，需要在 Windows 上：
  - 优先选择 `.cmd` 结尾的路径
  - 或者使用 `shell: true` 选项执行
- 当前方案是最简单可靠的修复，适用于大多数用户场景

