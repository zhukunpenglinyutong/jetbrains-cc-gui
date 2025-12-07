# Claude 临时目录与权限通道改进说明

## 背景
此前 `claude-agent-sdk` 会在运行 `Bash`/`Write` 等工具时：

- 把当前 `process.cwd()` 作为临时目录根路径并生成 `claude-xxxx-cwd` 标记文件；
- 在 `TMPDIR/claude-permission/` 下与 IDE 交换权限请求。

这会带来两个问题：

1. 项目根目录持续出现大量 `claude-*-cwd` 文件，影响使用体验；
2. 若我们把 `TMPDIR` 改到其它位置，Node 侧的 `permission-handler` 与 Java 侧 `PermissionService` 将监听不同目录，最终导致所有写入请求超时并被默认拒绝。

## 改动概览

### 1. 定制临时目录
- 在 `ClaudeSDKBridge` 启动任何 Node 子进程时，统一创建 `System.getProperty("java.io.tmpdir")/claude-agent-tmp`，并通过 `TMPDIR/TEMP/TMP` 环境变量强制使用该目录；
- 记录进程前后的 `claude-*-cwd` 文件，待进程结束后只保留原有文件，其余全部清理。

这样 IDE 项目目录不再出现无意义的临时标记文件，真实的临时数据会集中在系统 `tmp` 目录下，并在每次任务结束时自动回收。

### 2. 同步权限通道目录
- 新增 `CLAUDE_PERMISSION_DIR` 环境变量，并在 `updateProcessEnvironment` 中默认指向 `System.getProperty("java.io.tmpdir")/claude-permission`；
- `claude-bridge/permission-handler.js` 读取该变量，若不存在则回退到 `os.tmpdir()`；
- Java 端的 `PermissionService` 依然监听系统 `tmp/claude-permission`，因此 Node/Java 再次共享同一个通信目录，权限弹窗能正常弹出。

## 使用方式
1. **无需额外配置**：安装新版插件后自动启用上述逻辑；
2. **自定义路径**（可选）：若想把权限目录指向其它位置，可在 IDE 进程环境中设置 `CLAUDE_PERMISSION_DIR=/your/path/claude-permission`，Node 侧会按此目录写入，Java 侧同步读取；
3. **验证**：
   - 运行任意会写文件的指令（例如 “创建 hello.js”），应能看到权限弹窗；
   - 权限通过后，文件应成功写入，且项目根目录不再出现 `claude-*-cwd`；
   - 系统 `tmp/claude-agent-tmp` 目录中的残留文件会在指令结束后清理；若需排查，可手动查看该目录。

## 相关文件
- `src/main/java/com/github/claudecodegui/ClaudeSDKBridge.java`：负责设置 `TMPDIR`、清理临时文件、注入 `CLAUDE_PERMISSION_DIR`；
- `claude-bridge/permission-handler.js`：读取 `CLAUDE_PERMISSION_DIR` 并在该目录下与 Java 交互；
- `src/main/java/com/github/claudecodegui/permission/PermissionService.java`：继续监听系统 `tmp/claude-permission` 目录（无需修改）。

如需进一步扩展（例如把权限记录持久化到项目目录），可以基于 `CLAUDE_PERMISSION_DIR` 再封装自定义路径逻辑。

