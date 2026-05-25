# Codex Provider 环境变量设置功能

## 功能概述

为 Codex Provider 提供自定义环境变量设置功能，允许用户为消息子进程和 MCP 工具发现子进程分别注入独立的环境变量，与 `config.toml` 中的 `env_key` 机制完全独立。

## 需求约束

1. 环境变量与 `config.toml` 里的 `env_key` **无关联**，独立运作
2. 环境变量分为两类：
   - **Message EnvVars**：注入到 `sendMessage` 子进程
   - **MCP EnvVars**：注入到 `getMcpServerTools` 子进程
3. **禁止覆盖** Codex 内置环境变量

## 受保护的内置环境变量（不可设置）

```
CODEX_USE_STDIN, CODEX_MODEL, CODEX_SANDBOX_MODE, CODEX_SANDBOX,
CODEX_APPROVAL_POLICY, CODEX_CI, CODEX_SANDBOX_NETWORK_DISABLED,
CODEX_HOME, CLAUDE_SESSION_ID, CLAUDE_PERMISSION_DIR,
HOME, PATH, TMPDIR, TEMP, TMP, IDEA_PROJECT_PATH, PROJECT_PATH, CLAUDE_USE_STDIN
```

## 数据结构

### TypeScript 类型定义

```typescript
// webview/src/types/provider.ts

interface EnvVarEntry {
  key: string;
  value: string;
}

interface CodexProviderConfig {
  id: string;
  name: string;
  configToml: string;
  authJson: string;
  messageEnvVars?: EnvVarEntry[];  // 新增
  mcpEnvVars?: EnvVarEntry[];      // 新增
}
```

### JSON 存储格式

```json
{
  "id": "abc-123",
  "name": "My Provider",
  "configToml": "...",
  "authJson": "...",
  "messageEnvVars": [
    { "key": "MY_CUSTOM_ENDPOINT", "value": "https://..." },
    { "key": "DEBUG_FLAG", "value": "1" }
  ],
  "mcpEnvVars": [
    { "key": "MCP_TIMEOUT", "value": "30000" }
  ]
}
```

## UI 设计

### 组件结构

```
CodexProviderDialog
└── details.advanced-section
    ├── summary.advanced-toggle
    ├── div.form-group (Message EnvVars)
    │   ├── label
    │   ├── small.form-hint
    │   └── EnvVarEditor
    │       ├── envVarItem × N
    │       │   ├── input.keyInput
    │       │   ├── input.valueInput
    │       │   └── button.deleteBtn (codicon-trash)
    │       └── button.addBtn (codicon-add)
    └── div.form-group (MCP EnvVars)
        └── EnvVarEditor (同上)
```

### 样式支持

使用 CSS 变量实现黑暗模式兼容：

| CSS 变量 | 用途 |
|----------|------|
| `--bg-tertiary` | 输入框背景 |
| `--border-secondary` | 输入框边框 |
| `--text-primary` | 输入框文字 |
| `--text-placeholder` | 占位符文字 |
| `--accent-primary` | 聚焦边框 |
| `--color-error` | 删除按钮 hover |
| `--bg-secondary` | 按钮 hover 背景 |

## 校验规则

| 校验项 | 规则 | 错误提示 |
|--------|------|----------|
| Key 格式 | `^[a-zA-Z_][a-zA-Z0-9_]*$` | `envKeyInvalid` |
| 受保护变量 | 匹配 `CODEX_PROTECTED_ENV_KEYS` | `envKeyProtected` |
| 重复 Key | 大小写不敏感检测 | `envKeyDuplicate` |

## 后端注入逻辑

### Java 实现 (`CodexSDKBridge.java`)

```java
// 受保护变量集合
private static final Set<String> PROTECTED_ENV_KEYS = new HashSet<>(Arrays.asList(
    "CODEX_USE_STDIN", "CODEX_MODEL", "CODEX_SANDBOX_MODE", "CODEX_SANDBOX",
    "CODEX_APPROVAL_POLICY", "CODEX_CI", "CODEX_SANDBOX_NETWORK_DISABLED",
    "CODEX_HOME", "CLAUDE_SESSION_ID", "CLAUDE_PERMISSION_DIR",
    "HOME", "PATH", "TMPDIR", "TEMP", "TMP",
    "IDEA_PROJECT_PATH", "PROJECT_PATH", "CLAUDE_USE_STDIN"
));

// 注入自定义环境变量
private void injectCustomEnvVars(Map<String, String> env, String category) {
    CodemossSettingsService settings = new CodemossSettingsService();
    CodexProviderConfig provider = settings.getActiveCodexProvider();
    if (provider == null) return;

    List<EnvVarEntry> entries = "message".equals(category)
        ? provider.messageEnvVars
        : provider.mcpEnvVars;

    for (EnvVarEntry entry : entries) {
        String upperKey = entry.key.toUpperCase();
        if (PROTECTED_ENV_KEYS.contains(upperKey)) {
            // 日志警告并跳过
            log.warn("[Codex] Skipping protected env var: " + entry.key);
            continue;
        }
        env.put(entry.key, entry.value);
        log.info("[Codex] Injected custom env var: " + entry.key);
    }
}
```

### 注入时机

1. **sendMessage** (~line 460)：`configureCodexEnv(env)` 之后调用 `injectCustomEnvVars(env, "message")`
2. **getMcpServerTools** (~line 593)：`CODEX_USE_STDIN` 设置之后调用 `injectCustomEnvVars(pb.environment(), "mcp")`

## 国际化 i18n

### 新增 i18n Keys

路径：`settings.codexProvider.dialog`

| Key | 说明 | en | zh |
|-----|------|-----|-----|
| `envVarsTitle` | 环境变量区块标题 | Environment Variables | 环境变量 |
| `messageEnvLabel` | 消息环境变量标签 | Message Environment Variables | 消息环境变量 |
| `messageEnvHint` | 消息环境变量提示 | Custom environment variables injected into the Codex message subprocess | 注入到 Codex 消息子进程的自定义环境变量 |
| `mcpEnvLabel` | MCP 环境变量标签 | MCP Environment Variables | MCP 环境变量 |
| `mcpEnvHint` | MCP 环境变量提示 | Custom environment variables injected into the MCP tool discovery subprocess | 注入到 MCP 工具发现子进程的自定义环境变量 |
| `envKeyPlaceholder` | Key 输入框占位符 | ENV_KEY | 环境变量名 |
| `envValuePlaceholder` | Value 输入框占位符 | value | 值 |
| `addEnvVar` | 添加变量按钮文字 | Add Variable | 添加变量 |
| `envKeyInvalid` | Key 格式错误提示 | Invalid key name (must start with letter/underscore, alphanumeric only) | 无效的变量名（必须以字母或下划线开头，仅允许字母数字和下划线） |
| `envKeyProtected` | 受保护变量拦截提示 | Cannot set built-in variable: {{key}} | 无法设置内置变量：{{key}} |
| `envKeyDuplicate` | 重复 Key 提示 | Duplicate key: {{key}} | 重复的变量名：{{key}} |

## 文件清单

| 文件 | 变更类型 |
|------|----------|
| `webview/src/types/provider.ts` | 新增类型、常量、校验函数 |
| `webview/src/components/EnvVarEditor/index.tsx` | 新增 |
| `webview/src/components/EnvVarEditor/style.module.less` | 新增 |
| `webview/src/components/CodexProviderDialog.tsx` | 修改 |
| `webview/src/components/settings/hooks/useCodexProviderManagement.ts` | 修改 |
| `webview/src/i18n/locales/en.json` | 新增 i18n keys |
| `webview/src/i18n/locales/zh.json` | 新增 i18n keys |
| `src/main/java/.../CodexSDKBridge.java` | 新增注入逻辑 |
| `build.gradle` | 新增 npm install 步骤 |

## 构建说明

`packageAiBridge` task 会自动检查 `ai-bridge/node_modules` 是否存在，如不存在则自动运行 `npm install`。

```
./gradlew clean buildPlugin
```

产物：`build/distributions/idea-claude-code-gui-{version}.zip`
