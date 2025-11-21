# Agent SDK 参考 - TypeScript

TypeScript Agent SDK 的完整 API 参考，包括所有函数、类型和接口。

---

@anthropic-ai/claude-agent-sdk

<script src="/components/typescript-sdk-type-links.js" defer />

## 安装

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## 函数

### `query()`

与 Claude Code 交互的主要函数。创建一个异步生成器，在消息到达时流式传输消息。

```typescript
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query
```

#### 参数

| 参数 | 类型 | 描述 |
| :--- | :--- | :--- |
| `prompt` | `string \| AsyncIterable<`[`SDKUserMessage`](#sdkusermessage)`>` | 输入提示，可以是字符串或用于流式模式的异步可迭代对象 |
| `options` | [`Options`](#options) | 可选配置对象（参见下面的 Options 类型） |

#### 返回值

返回一个 [`Query`](#query-1) 对象，它扩展了 `AsyncGenerator<`[`SDKMessage`](#sdkmessage)`, void>` 并具有额外的方法。

### `tool()`

创建一个类型安全的 MCP 工具定义，用于 SDK MCP 服务器。

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

#### 参数

| 参数 | 类型 | 描述 |
| :--- | :--- | :--- |
| `name` | `string` | 工具的名称 |
| `description` | `string` | 工具功能的描述 |
| `inputSchema` | `Schema extends ZodRawShape` | 定义工具输入参数的 Zod 模式 |
| `handler` | `(args, extra) => Promise<`[`CallToolResult`](#calltoolresult)`>` | 执行工具逻辑的异步函数 |

### `createSdkMcpServer()`

创建一个在与应用程序相同进程中运行的 MCP 服务器实例。

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

#### 参数

| 参数 | 类型 | 描述 |
| :--- | :--- | :--- |
| `options.name` | `string` | MCP 服务器的名称 |
| `options.version` | `string` | 可选版本字符串 |
| `options.tools` | `Array<SdkMcpToolDefinition>` | 使用 [`tool()`](#tool) 创建的工具定义数组 |

## 类型

### `Options`

`query()` 函数的配置对象。

| 属性 | 类型 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- |
| `abortController` | `AbortController` | `new AbortController()` | 用于取消操作的控制器 |
| `additionalDirectories` | `string[]` | `[]` | Claude 可以访问的其他目录 |
| `agents` | `Record<string, [`AgentDefinition`](#agentdefinition)>` | `undefined` | 以编程方式定义子代理 |
| `allowedTools` | `string[]` | 所有工具 | 允许的工具名称列表 |
| `canUseTool` | [`CanUseTool`](#canusetool) | `undefined` | 用于工具使用的自定义权限函数 |
| `continue` | `boolean` | `false` | 继续最近的对话 |
| `cwd` | `string` | `process.cwd()` | 当前工作目录 |
| `disallowedTools` | `string[]` | `[]` | 不允许的工具名称列表 |
| `env` | `Dict<string>` | `process.env` | 环境变量 |
| `executable` | `'bun' \| 'deno' \| 'node'` | 自动检测 | 要使用的 JavaScript 运行时 |
| `executableArgs` | `string[]` | `[]` | 传递给可执行文件的参数 |
| `extraArgs` | `Record<string, string \| null>` | `{}` | 其他参数 |
| `fallbackModel` | `string` | `undefined` | 主模型失败时使用的模型 |
| `forkSession` | `boolean` | `false` | 使用 `resume` 恢复时，分叉到新的会话 ID 而不是继续原始会话 |
| `hooks` | `Partial<Record<`[`HookEvent`](#hookevent)`, `[`HookCallbackMatcher`](#hookcallbackmatcher)`[]>>` | `{}` | 事件的钩子回调 |
| `includePartialMessages` | `boolean` | `false` | 包含部分消息事件 |
| `maxThinkingTokens` | `number` | `undefined` | 思考过程的最大令牌数 |
| `maxTurns` | `number` | `undefined` | 最大对话轮数 |
| `mcpServers` | `Record<string, [`McpServerConfig`](#mcpserverconfig)>` | `{}` | MCP 服务器配置 |
| `model` | `string` | CLI 默认值 | 要使用的 Claude 模型 |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | 定义代理结果的输出格式。详见 [结构化输出](/docs/zh-CN/agent-sdk/structured-outputs) |
| `pathToClaudeCodeExecutable` | `string` | 自动检测 | Claude Code 可执行文件的路径 |
| `permissionMode` | [`PermissionMode`](#permissionmode) | `'default'` | 会话的权限模式 |
| `permissionPromptToolName` | `string` | `undefined` | 权限提示的 MCP 工具名称 |
| `plugins` | [`SdkPluginConfig`](#sdkpluginconfig)`[]` | `[]` | 从本地路径加载自定义插件。详见 [插件](/docs/zh-CN/agent-sdk/plugins) |
| `resume` | `string` | `undefined` | 要恢复的会话 ID |
| `settingSources` | [`SettingSource`](#settingsource)`[]` | `[]`（无设置） | 控制要加载哪些文件系统设置。省略时，不加载任何设置。**注意：** 必须包含 `'project'` 以加载 CLAUDE.md 文件 |
| `stderr` | `(data: string) => void` | `undefined` | stderr 输出的回调 |
| `strictMcpConfig` | `boolean` | `false` | 强制执行严格的 MCP 验证 |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined`（空提示） | 系统提示配置。传递字符串以获得自定义提示，或传递 `{ type: 'preset', preset: 'claude_code' }` 以使用 Claude Code 的系统提示。使用预设对象形式时，添加 `append` 以使用其他说明扩展系统提示 |

### `Query`

`query()` 函数返回的接口。

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
}
```

#### 方法

| 方法 | 描述 |
| :--- | :--- |
| `interrupt()` | 中断查询（仅在流式输入模式下可用） |
| `setPermissionMode()` | 更改权限模式（仅在流式输入模式下可用） |

### `AgentDefinition`

以编程方式定义的子代理的配置。

```typescript
type AgentDefinition = {
  description: string;
  tools?: string[];
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

| 字段 | 必需 | 描述 |
|:---|:---|:---|
| `description` | 是 | 何时使用此代理的自然语言描述 |
| `tools` | 否 | 允许的工具名称数组。如果省略，继承所有工具 |
| `prompt` | 是 | 代理的系统提示 |
| `model` | 否 | 此代理的模型覆盖。如果省略，使用主模型 |

### `SettingSource`

控制 SDK 从哪些基于文件系统的配置源加载设置。

```typescript
type SettingSource = 'user' | 'project' | 'local';
```

| 值 | 描述 | 位置 |
|:---|:---|:---|
| `'user'` | 全局用户设置 | `~/.claude/settings.json` |
| `'project'` | 共享项目设置（版本控制） | `.claude/settings.json` |
| `'local'` | 本地项目设置（gitignored） | `.claude/settings.local.json` |

#### 默认行为

当 `settingSources` **被省略**或**未定义**时，SDK **不会**加载任何文件系统设置。这为 SDK 应用程序提供了隔离。

#### 为什么使用 settingSources？

**加载所有文件系统设置（旧版行为）：**
```typescript
// 像 SDK v0.0.x 一样加载所有设置
const result = query({
  prompt: "分析这段代码",
  options: {
    settingSources: ['user', 'project', 'local']  // 加载所有设置
  }
});
```

**仅加载特定设置源：**
```typescript
// 仅加载项目设置，忽略用户和本地设置
const result = query({
  prompt: "运行 CI 检查",
  options: {
    settingSources: ['project']  // 仅 .claude/settings.json
  }
});
```

**测试和 CI 环境：**
```typescript
// 通过排除本地设置确保 CI 中的一致行为
const result = query({
  prompt: "运行测试",
  options: {
    settingSources: ['project'],  // 仅团队共享设置
    permissionMode: 'bypassPermissions'
  }
});
```

**仅 SDK 应用程序：**
```typescript
// 以编程方式定义所有内容（默认行为）
// 无文件系统依赖 - settingSources 默认为 []
const result = query({
  prompt: "审查此 PR",
  options: {
    // settingSources: [] 是默认值，无需指定
    agents: { /* ... */ },
    mcpServers: { /* ... */ },
    allowedTools: ['Read', 'Grep', 'Glob']
  }
});
```

**加载 CLAUDE.md 项目说明：**
```typescript
// 加载项目设置以包含 CLAUDE.md 文件
const result = query({
  prompt: "按照项目约定添加新功能",
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code'  // 使用 CLAUDE.md 所需
    },
    settingSources: ['project'],  // 从项目目录加载 CLAUDE.md
    allowedTools: ['Read', 'Write', 'Edit']
  }
});
```

#### 设置优先级

加载多个源时，设置按此优先级合并（从高到低）：
1. 本地设置（`.claude/settings.local.json`）
2. 项目设置（`.claude/settings.json`）
3. 用户设置（`~/.claude/settings.json`）

编程选项（如 `agents`、`allowedTools`）始终覆盖文件系统设置。

### `PermissionMode`

```typescript
type PermissionMode =
  | 'default'           // 标准权限行为
  | 'acceptEdits'       // 自动接受文件编辑
  | 'bypassPermissions' // 绕过所有权限检查
  | 'plan'              // 规划模式 - 无执行
```

### `CanUseTool`

用于控制工具使用的自定义权限函数类型。

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
  }
) => Promise<PermissionResult>;
```

### `PermissionResult`

权限检查的结果。

```typescript
type PermissionResult = 
  | {
      behavior: 'allow';
      updatedInput: ToolInput;
      updatedPermissions?: PermissionUpdate[];
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
    }
```

### `McpServerConfig`

MCP 服务器的配置。

```typescript
type McpServerConfig = 
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;
```

#### `McpStdioServerConfig`

```typescript
type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
```

#### `McpSSEServerConfig`

```typescript
type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}
```

#### `McpHttpServerConfig`

```typescript
type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}
```

#### `McpSdkServerConfigWithInstance`

```typescript
type McpSdkServerConfigWithInstance = {
  type: 'sdk';
  name: string;
  instance: McpServer;
}
```

### `SdkPluginConfig`

SDK 中加载插件的配置。

```typescript
type SdkPluginConfig = {
  type: 'local';
  path: string;
}
```

| 字段 | 类型 | 描述 |
|:---|:---|:---|
| `type` | `'local'` | 必须是 `'local'`（目前仅支持本地插件） |
| `path` | `string` | 插件目录的绝对或相对路径 |

**示例：**
```typescript
plugins: [
  { type: 'local', path: './my-plugin' },
  { type: 'local', path: '/absolute/path/to/plugin' }
]
```

有关创建和使用插件的完整信息，请参阅 [插件](/docs/zh-CN/agent-sdk/plugins)。

## 消息类型

### `SDKMessage`

查询返回的所有可能消息的联合类型。

```typescript
type SDKMessage = 
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKUserMessageReplay
  | SDKResultMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKCompactBoundaryMessage;
```

### `SDKAssistantMessage`

助手响应消息。

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // 来自 Anthropic SDK
  parent_tool_use_id: string | null;
}
```

### `SDKUserMessage`

用户输入消息。

```typescript
type SDKUserMessage = {
  type: 'user';
  uuid?: UUID;
  session_id: string;
  message: APIUserMessage; // 来自 Anthropic SDK
  parent_tool_use_id: string | null;
}
```

### `SDKUserMessageReplay`

带有必需 UUID 的重放用户消息。

```typescript
type SDKUserMessageReplay = {
  type: 'user';
  uuid: UUID;
  session_id: string;
  message: APIUserMessage;
  parent_tool_use_id: string | null;
}
```

### `SDKResultMessage`

最终结果消息。

```typescript
type SDKResultMessage = 
  | {
      type: 'result';
      subtype: 'success';
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      total_cost_usd: number;
      usage: NonNullableUsage;
      permission_denials: SDKPermissionDenial[];
    }
  | {
      type: 'result';
      subtype: 'error_max_turns' | 'error_during_execution';
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      total_cost_usd: number;
      usage: NonNullableUsage;
      permission_denials: SDKPermissionDenial[];
    }
```

### `SDKSystemMessage`

系统初始化消息。

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: {
    name: string;
    status: string;
  }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
}
```

### `SDKPartialAssistantMessage`

流式部分消息（仅当 `includePartialMessages` 为 true 时）。

```typescript
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: RawMessageStreamEvent; // 来自 Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
}
```

### `SDKCompactBoundaryMessage`

指示对话压缩边界的消息。

```typescript
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  uuid: UUID;
  session_id: string;
  compact_metadata: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
  };
}
```

### `SDKPermissionDenial`

有关被拒绝的工具使用的信息。

```typescript
type SDKPermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: ToolInput;
}
```

## 钩子类型

### `HookEvent`

可用的钩子事件。

```typescript
type HookEvent = 
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact';
```

### `HookCallback`

钩子回调函数类型。

```typescript
type HookCallback = (
  input: HookInput, // 所有钩子输入类型的联合
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### `HookCallbackMatcher`

带有可选匹配器的钩子配置。

```typescript
interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
}
```

### `HookInput`

所有钩子输入类型的联合类型。

```typescript
type HookInput = 
  | PreToolUseHookInput
  | PostToolUseHookInput
  | NotificationHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | SubagentStopHookInput
  | PreCompactHookInput;
```

### `BaseHookInput`

所有钩子输入类型扩展的基础接口。

```typescript
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
}
```

#### `PreToolUseHookInput`

```typescript
type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: ToolInput;
}
```

#### `PostToolUseHookInput`

```typescript
type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: ToolInput;
  tool_response: ToolOutput;
}
```

#### `NotificationHookInput`

```typescript
type NotificationHookInput = BaseHookInput & {
  hook_event_name: 'Notification';
  message: string;
  title?: string;
}
```

#### `UserPromptSubmitHookInput`

```typescript
type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}
```

#### `SessionStartHookInput`

```typescript
type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
}
```

#### `SessionEndHookInput`

```typescript
type SessionEndHookInput = BaseHookInput & {
  hook_event_name: 'SessionEnd';
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
}
```

#### `StopHookInput`

```typescript
type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
}
```

#### `SubagentStopHookInput`

```typescript
type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
}
```

#### `PreCompactHookInput`

```typescript
type PreCompactHookInput = BaseHookInput & {
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions: string | null;
}
```

### `HookJSONOutput`

钩子返回值。

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;
```

#### `AsyncHookJSONOutput`

```typescript
type AsyncHookJSONOutput = {
  async: true;
  asyncTimeout?: number;
}
```

#### `SyncHookJSONOutput`

```typescript
type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | {
        hookEventName: 'PreToolUse';
        permissionDecision?: 'allow' | 'deny' | 'ask';
        permissionDecisionReason?: string;
      }
    | {
        hookEventName: 'UserPromptSubmit';
        additionalContext?: string;
      }
    | {
        hookEventName: 'SessionStart';
        additionalContext?: string;
      }
    | {
        hookEventName: 'PostToolUse';
        additionalContext?: string;
      };
}
```

## 工具输入类型

所有内置 Claude Code 工具的输入模式文档。这些类型从 `@anthropic-ai/claude-agent-sdk` 导出，可用于类型安全的工具交互。

### `ToolInput`

**注意：** 这是一个仅用于清晰起见的文档类型。它表示所有工具输入类型的联合。

```typescript
type ToolInput = 
  | AgentInput
  | BashInput
  | BashOutputInput
  | FileEditInput
  | FileReadInput
  | FileWriteInput
  | GlobInput
  | GrepInput
  | KillShellInput
  | NotebookEditInput
  | WebFetchInput
  | WebSearchInput
  | TodoWriteInput
  | ExitPlanModeInput
  | ListMcpResourcesInput
  | ReadMcpResourceInput;
```

### Task

**工具名称：** `Task`

```typescript
interface AgentInput {
  /**
   * 任务的简短（3-5 个单词）描述
   */
  description: string;
  /**
   * 代理要执行的任务
   */
  prompt: string;
  /**
   * 用于此任务的专门代理类型
   */
  subagent_type: string;
}
```

启动一个新代理来自主处理复杂的多步骤任务。

### Bash

**工具名称：** `Bash`

```typescript
interface BashInput {
  /**
   * 要执行的命令
   */
  command: string;
  /**
   * 可选超时时间（以毫秒为单位，最多 600000）
   */
  timeout?: number;
  /**
   * 清晰简洁的描述，说明此命令在 5-10 个单词内的作用
   */
  description?: string;
  /**
   * 设置为 true 以在后台运行此命令
   */
  run_in_background?: boolean;
}
```

在持久 shell 会话中执行 bash 命令，支持可选的超时和后台执行。

### BashOutput

**工具名称：** `BashOutput`

```typescript
interface BashOutputInput {
  /**
   * 要从中检索输出的后台 shell 的 ID
   */
  bash_id: string;
  /**
   * 可选的正则表达式以过滤输出行
   */
  filter?: string;
}
```

从运行中或已完成的后台 bash shell 检索输出。

### Edit

**工具名称：** `Edit`

```typescript
interface FileEditInput {
  /**
   * 要修改的文件的绝对路径
   */
  file_path: string;
  /**
   * 要替换的文本
   */
  old_string: string;
  /**
   * 替换为的文本（必须与 old_string 不同）
   */
  new_string: string;
  /**
   * 替换 old_string 的所有出现（默认为 false）
   */
  replace_all?: boolean;
}
```

在文件中执行精确字符串替换。

### Read

**工具名称：** `Read`

```typescript
interface FileReadInput {
  /**
   * 要读取的文件的绝对路径
   */
  file_path: string;
  /**
   * 开始读取的行号
   */
  offset?: number;
  /**
   * 要读取的行数
   */
  limit?: number;
}
```

从本地文件系统读取文件，包括文本、图像、PDF 和 Jupyter 笔记本。

### Write

**工具名称：** `Write`

```typescript
interface FileWriteInput {
  /**
   * 要写入的文件的绝对路径
   */
  file_path: string;
  /**
   * 要写入文件的内容
   */
  content: string;
}
```

将文件写入本地文件系统，如果存在则覆盖。

### Glob

**工具名称：** `Glob`

```typescript
interface GlobInput {
  /**
   * 用于匹配文件的 glob 模式
   */
  pattern: string;
  /**
   * 要搜索的目录（默认为 cwd）
   */
  path?: string;
}
```

快速文件模式匹配，适用于任何代码库大小。

### Grep

**工具名称：** `Grep`

```typescript
interface GrepInput {
  /**
   * 要搜索的正则表达式模式
   */
  pattern: string;
  /**
   * 要搜索的文件或目录（默认为 cwd）
   */
  path?: string;
  /**
   * 用于过滤文件的 glob 模式（例如 "*.js"）
   */
  glob?: string;
  /**
   * 要搜索的文件类型（例如 "js"、"py"、"rust"）
   */
  type?: string;
  /**
   * 输出模式："content"、"files_with_matches" 或 "count"
   */
  output_mode?: 'content' | 'files_with_matches' | 'count';
  /**
   * 不区分大小写的搜索
   */
  '-i'?: boolean;
  /**
   * 显示行号（用于内容模式）
   */
  '-n'?: boolean;
  /**
   * 每个匹配项前显示的行数
   */
  '-B'?: number;
  /**
   * 每个匹配项后显示的行数
   */
  '-A'?: number;
  /**
   * 每个匹配项前后显示的行数
   */
  '-C'?: number;
  /**
   * 将输出限制为前 N 行/条目
   */
  head_limit?: number;
  /**
   * 启用多行模式
   */
  multiline?: boolean;
}
```

基于 ripgrep 的强大搜索工具，支持正则表达式。

### KillBash

**工具名称：** `KillBash`

```typescript
interface KillShellInput {
  /**
   * 要终止的后台 shell 的 ID
   */
  shell_id: string;
}
```

按 ID 终止运行中的后台 bash shell。

### NotebookEdit

**工具名称：** `NotebookEdit`

```typescript
interface NotebookEditInput {
  /**
   * Jupyter 笔记本文件的绝对路径
   */
  notebook_path: string;
  /**
   * 要编辑的单元格的 ID
   */
  cell_id?: string;
  /**
   * 单元格的新源代码
   */
  new_source: string;
  /**
   * 单元格的类型（代码或降价）
   */
  cell_type?: 'code' | 'markdown';
  /**
   * 编辑类型（替换、插入、删除）
   */
  edit_mode?: 'replace' | 'insert' | 'delete';
}
```

编辑 Jupyter 笔记本文件中的单元格。

### WebFetch

**工具名称：** `WebFetch`

```typescript
interface WebFetchInput {
  /**
   * 要从中获取内容的 URL
   */
  url: string;
  /**
   * 在获取的内容上运行的提示
   */
  prompt: string;
}
```

从 URL 获取内容并使用 AI 模型处理它。

### WebSearch

**工具名称：** `WebSearch`

```typescript
interface WebSearchInput {
  /**
   * 要使用的搜索查询
   */
  query: string;
  /**
   * 仅包含来自这些域的结果
   */
  allowed_domains?: string[];
  /**
   * 永远不包含来自这些域的结果
   */
  blocked_domains?: string[];
}
```

搜索网络并返回格式化的结果。

### TodoWrite

**工具名称：** `TodoWrite`

```typescript
interface TodoWriteInput {
  /**
   * 更新的待办事项列表
   */
  todos: Array<{
    /**
     * 任务描述
     */
    content: string;
    /**
     * 任务状态
     */
    status: 'pending' | 'in_progress' | 'completed';
    /**
     * 任务描述的主动形式
     */
    activeForm: string;
  }>;
}
```

创建和管理结构化任务列表以跟踪进度。

### ExitPlanMode

**工具名称：** `ExitPlanMode`

```typescript
interface ExitPlanModeInput {
  /**
   * 用户批准运行的计划
   */
  plan: string;
}
```

退出规划模式并提示用户批准计划。

### ListMcpResources

**工具名称：** `ListMcpResources`

```typescript
interface ListMcpResourcesInput {
  /**
   * 可选的服务器名称以按其过滤资源
   */
  server?: string;
}
```

列出来自连接服务器的可用 MCP 资源。

### ReadMcpResource

**工具名称：** `ReadMcpResource`

```typescript
interface ReadMcpResourceInput {
  /**
   * MCP 服务器名称
   */
  server: string;
  /**
   * 要读取的资源 URI
   */
  uri: string;
}
```

从服务器读取特定的 MCP 资源。

## 工具输出类型

所有内置 Claude Code 工具的输出模式文档。这些类型表示每个工具返回的实际响应数据。

### `ToolOutput`

**注意：** 这是一个仅用于清晰起见的文档类型。它表示所有工具输出类型的联合。

```typescript
type ToolOutput = 
  | TaskOutput
  | BashOutput
  | BashOutputToolOutput
  | EditOutput
  | ReadOutput
  | WriteOutput
  | GlobOutput
  | GrepOutput
  | KillBashOutput
  | NotebookEditOutput
  | WebFetchOutput
  | WebSearchOutput
  | TodoWriteOutput
  | ExitPlanModeOutput
  | ListMcpResourcesOutput
  | ReadMcpResourceOutput;
```

### Task

**工具名称：** `Task`

```typescript
interface TaskOutput {
  /**
   * 来自子代理的最终结果消息
   */
  result: string;
  /**
   * 令牌使用统计
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /**
   * 总成本（美元）
   */
  total_cost_usd?: number;
  /**
   * 执行持续时间（毫秒）
   */
  duration_ms?: number;
}
```

返回子代理完成委派任务后的最终结果。

### Bash

**工具名称：** `Bash`

```typescript
interface BashOutput {
  /**
   * 标准输出和标准错误的组合输出
   */
  output: string;
  /**
   * 命令的退出代码
   */
  exitCode: number;
  /**
   * 命令是否因超时而被终止
   */
  killed?: boolean;
  /**
   * 后台进程的 Shell ID
   */
  shellId?: string;
}
```

返回命令输出和退出状态。后台命令立即返回 shellId。

### BashOutput

**工具名称：** `BashOutput`

```typescript
interface BashOutputToolOutput {
  /**
   * 自上次检查以来的新输出
   */
  output: string;
  /**
   * 当前 shell 状态
   */
  status: 'running' | 'completed' | 'failed';
  /**
   * 退出代码（完成时）
   */
  exitCode?: number;
}
```

返回来自后台 shell 的增量输出。

### Edit

**工具名称：** `Edit`

```typescript
interface EditOutput {
  /**
   * 确认消息
   */
  message: string;
  /**
   * 进行的替换次数
   */
  replacements: number;
  /**
   * 被编辑的文件路径
   */
  file_path: string;
}
```

返回成功编辑的确认和替换计数。

### Read

**工具名称：** `Read`

```typescript
type ReadOutput = 
  | TextFileOutput
  | ImageFileOutput
  | PDFFileOutput
  | NotebookFileOutput;

interface TextFileOutput {
  /**
   * 带行号的文件内容
   */
  content: string;
  /**
   * 文件中的总行数
   */
  total_lines: number;
  /**
   * 实际返回的行数
   */
  lines_returned: number;
}

interface ImageFileOutput {
  /**
   * Base64 编码的图像数据
   */
  image: string;
  /**
   * 图像 MIME 类型
   */
  mime_type: string;
  /**
   * 文件大小（字节）
   */
  file_size: number;
}

interface PDFFileOutput {
  /**
   * 页面内容数组
   */
  pages: Array<{
    page_number: number;
    text?: string;
    images?: Array<{
      image: string;
      mime_type: string;
    }>;
  }>;
  /**
   * 总页数
   */
  total_pages: number;
}

interface NotebookFileOutput {
  /**
   * Jupyter 笔记本单元格
   */
  cells: Array<{
    cell_type: 'code' | 'markdown';
    source: string;
    outputs?: any[];
    execution_count?: number;
  }>;
  /**
   * 笔记本元数据
   */
  metadata?: Record<string, any>;
}
```

以适合文件类型的格式返回文件内容。

### Write

**工具名称：** `Write`

```typescript
interface WriteOutput {
  /**
   * 成功消息
   */
  message: string;
  /**
   * 写入的字节数
   */
  bytes_written: number;
  /**
   * 被写入的文件路径
   */
  file_path: string;
}
```

成功写入文件后返回确认。

### Glob

**工具名称：** `Glob`

```typescript
interface GlobOutput {
  /**
   * 匹配的文件路径数组
   */
  matches: string[];
  /**
   * 找到的匹配数
   */
  count: number;
  /**
   * 使用的搜索目录
   */
  search_path: string;
}
```

返回与 glob 模式匹配的文件路径，按修改时间排序。

### Grep

**工具名称：** `Grep`

```typescript
type GrepOutput = 
  | GrepContentOutput
  | GrepFilesOutput
  | GrepCountOutput;

interface GrepContentOutput {
  /**
   * 带上下文的匹配行
   */
  matches: Array<{
    file: string;
    line_number?: number;
    line: string;
    before_context?: string[];
    after_context?: string[];
  }>;
  /**
   * 匹配总数
   */
  total_matches: number;
}

interface GrepFilesOutput {
  /**
   * 包含匹配的文件
   */
  files: string[];
  /**
   * 包含匹配的文件数
   */
  count: number;
}

interface GrepCountOutput {
  /**
   * 每个文件的匹配计数
   */
  counts: Array<{
    file: string;
    count: number;
  }>;
  /**
   * 所有文件中的总匹配数
   */
  total: number;
}
```

以 output_mode 指定的格式返回搜索结果。

### KillBash

**工具名称：** `KillBash`

```typescript
interface KillBashOutput {
  /**
   * 成功消息
   */
  message: string;
  /**
   * 被终止的 shell 的 ID
   */
  shell_id: string;
}
```

终止后台 shell 后返回确认。

### NotebookEdit

**工具名称：** `NotebookEdit`

```typescript
interface NotebookEditOutput {
  /**
   * 成功消息
   */
  message: string;
  /**
   * 执行的编辑类型
   */
  edit_type: 'replaced' | 'inserted' | 'deleted';
  /**
   * 受影响的单元格 ID
   */
  cell_id?: string;
  /**
   * 编辑后笔记本中的总单元格数
   */
  total_cells: number;
}
```

修改 Jupyter 笔记本后返回确认。

### WebFetch

**工具名称：** `WebFetch`

```typescript
interface WebFetchOutput {
  /**
   * AI 模型对提示的响应
   */
  response: string;
  /**
   * 被获取的 URL
   */
  url: string;
  /**
   * 重定向后的最终 URL
   */
  final_url?: string;
  /**
   * HTTP 状态代码
   */
  status_code?: number;
}
```

返回 AI 对获取的网络内容的分析。

### WebSearch

**工具名称：** `WebSearch`

```typescript
interface WebSearchOutput {
  /**
   * 搜索结果
   */
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    /**
     * 如果可用的其他元数据
     */
    metadata?: Record<string, any>;
  }>;
  /**
   * 结果总数
   */
  total_results: number;
  /**
   * 被搜索的查询
   */
  query: string;
}
```

返回来自网络的格式化搜索结果。

### TodoWrite

**工具名称：** `TodoWrite`

```typescript
interface TodoWriteOutput {
  /**
   * 成功消息
   */
  message: string;
  /**
   * 当前待办事项统计
   */
  stats: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
  };
}
```

返回确认和当前任务统计。

### ExitPlanMode

**工具名称：** `ExitPlanMode`

```typescript
interface ExitPlanModeOutput {
  /**
   * 确认消息
   */
  message: string;
  /**
   * 用户是否批准了计划
   */
  approved?: boolean;
}
```

退出规划模式后返回确认。

### ListMcpResources

**工具名称：** `ListMcpResources`

```typescript
interface ListMcpResourcesOutput {
  /**
   * 可用资源
   */
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    server: string;
  }>;
  /**
   * 资源总数
   */
  total: number;
}
```

返回可用 MCP 资源的列表。

### ReadMcpResource

**工具名称：** `ReadMcpResource`

```typescript
interface ReadMcpResourceOutput {
  /**
   * 资源内容
   */
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
  /**
   * 提供资源的服务器
   */
  server: string;
}
```

返回请求的 MCP 资源的内容。

## 权限类型

### `PermissionUpdate`

用于更新权限的操作。

```typescript
type PermissionUpdate = 
  | {
      type: 'addRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'replaceRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'removeRules';
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'setMode';
      mode: PermissionMode;
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'addDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    }
  | {
      type: 'removeDirectories';
      directories: string[];
      destination: PermissionUpdateDestination;
    }
```

### `PermissionBehavior`

```typescript
type PermissionBehavior = 'allow' | 'deny' | 'ask';
```

### `PermissionUpdateDestination`

```typescript
type PermissionUpdateDestination = 
  | 'userSettings'     // 全局用户设置
  | 'projectSettings'  // 按目录项目设置
  | 'localSettings'    // Gitignored 本地设置
  | 'session'          // 仅当前会话
```

### `PermissionRuleValue`

```typescript
type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
}
```

## 其他类型

### `ApiKeySource`

```typescript
type ApiKeySource = 'user' | 'project' | 'org' | 'temporary';
```

### `ConfigScope`

```typescript
type ConfigScope = 'local' | 'user' | 'project';
```

### `NonNullableUsage`

[`Usage`](#usage) 的一个版本，所有可空字段都变为不可空。

```typescript
type NonNullableUsage = {
  [K in keyof Usage]: NonNullable<Usage[K]>;
}
```

### `Usage`

令牌使用统计（来自 `@anthropic-ai/sdk`）。

```typescript
type Usage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}
```

### `CallToolResult`

MCP 工具结果类型（来自 `@modelcontextprotocol/sdk/types.js`）。

```typescript
type CallToolResult = {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    // 其他字段因类型而异
  }>;
  isError?: boolean;
}
```

### `AbortError`

用于中止操作的自定义错误类。

```typescript
class AbortError extends Error {}
```

## 另请参阅

- [SDK 概述](/docs/zh-CN/agent-sdk/overview) - 常规 SDK 概念
- [Python SDK 参考](/docs/zh-CN/agent-sdk/python) - Python SDK 文档
- [CLI 参考](https://code.claude.com/docs/en/cli-reference) - 命令行界面
- [常见工作流](https://code.claude.com/docs/en/common-workflows) - 分步指南