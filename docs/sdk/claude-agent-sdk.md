# Agent SDK reference - TypeScript

Complete API reference for the TypeScript Agent SDK, including all functions, types, and interfaces.

---

<script src="/components/typescript-sdk-type-links.js" defer />

<Note>
**Try the new V2 interface (preview):** A simplified interface with `send()` and `receive()` patterns is now available, making multi-turn conversations easier. [Learn more](/docs/en/agent-sdk/typescript-v2-preview)
</Note>

## Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## Functions

### `query()`

The primary function for interacting with Claude Code. Creates an async generator that streams messages as they arrive.

```typescript
function query({
  prompt,
  options
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query
```

#### Parameters

| Parameter | Type | Description |
| :-------- | :--- | :---------- |
| `prompt` | `string \| AsyncIterable<`[`SDKUserMessage`](#sdkusermessage)`>` | The input prompt as a string or async iterable for streaming mode |
| `options` | [`Options`](#options) | Optional configuration object (see Options type below) |

#### Returns

Returns a [`Query`](#query-1) object that extends `AsyncGenerator<`[`SDKMessage`](#sdkmessage)`, void>` with additional methods.

### `tool()`

Creates a type-safe MCP tool definition for use with SDK MCP servers.

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

#### Parameters

| Parameter | Type | Description |
| :-------- | :--- | :---------- |
| `name` | `string` | The name of the tool |
| `description` | `string` | A description of what the tool does |
| `inputSchema` | `Schema extends ZodRawShape` | Zod schema defining the tool's input parameters |
| `handler` | `(args, extra) => Promise<`[`CallToolResult`](#calltoolresult)`>` | Async function that executes the tool logic |

### `createSdkMcpServer()`

Creates an MCP server instance that runs in the same process as your application.

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

#### Parameters

| Parameter | Type | Description |
| :-------- | :--- | :---------- |
| `options.name` | `string` | The name of the MCP server |
| `options.version` | `string` | Optional version string |
| `options.tools` | `Array<SdkMcpToolDefinition>` | Array of tool definitions created with [`tool()`](#tool) |

## Types

### `Options`

Configuration object for the `query()` function.

| Property | Type | Default | Description |
| :------- | :--- | :------ | :---------- |
| `abortController` | `AbortController` | `new AbortController()` | Controller for cancelling operations |
| `additionalDirectories` | `string[]` | `[]` | Additional directories Claude can access |
| `agents` | `Record<string, [`AgentDefinition`](#agentdefinition)>` | `undefined` | Programmatically define subagents |
| `allowDangerouslySkipPermissions` | `boolean` | `false` | Enable bypassing permissions. Required when using `permissionMode: 'bypassPermissions'` |
| `allowedTools` | `string[]` | All tools | List of allowed tool names |
| `betas` | [`SdkBeta`](#sdkbeta)`[]` | `[]` | Enable beta features (e.g., `['context-1m-2025-08-07']`) |
| `canUseTool` | [`CanUseTool`](#canusetool) | `undefined` | Custom permission function for tool usage |
| `continue` | `boolean` | `false` | Continue the most recent conversation |
| `cwd` | `string` | `process.cwd()` | Current working directory |
| `disallowedTools` | `string[]` | `[]` | List of disallowed tool names |
| `enableFileCheckpointing` | `boolean` | `false` | Enable file change tracking for rewinding. See [File checkpointing](/docs/en/agent-sdk/file-checkpointing) |
| `env` | `Dict<string>` | `process.env` | Environment variables |
| `executable` | `'bun' \| 'deno' \| 'node'` | Auto-detected | JavaScript runtime to use |
| `executableArgs` | `string[]` | `[]` | Arguments to pass to the executable |
| `extraArgs` | `Record<string, string \| null>` | `{}` | Additional arguments |
| `fallbackModel` | `string` | `undefined` | Model to use if primary fails |
| `forkSession` | `boolean` | `false` | When resuming with `resume`, fork to a new session ID instead of continuing the original session |
| `hooks` | `Partial<Record<`[`HookEvent`](#hookevent)`, `[`HookCallbackMatcher`](#hookcallbackmatcher)`[]>>` | `{}` | Hook callbacks for events |
| `includePartialMessages` | `boolean` | `false` | Include partial message events |
| `maxBudgetUsd` | `number` | `undefined` | Maximum budget in USD for the query |
| `maxThinkingTokens` | `number` | `undefined` | Maximum tokens for thinking process |
| `maxTurns` | `number` | `undefined` | Maximum conversation turns |
| `mcpServers` | `Record<string, [`McpServerConfig`](#mcpserverconfig)>` | `{}` | MCP server configurations |
| `model` | `string` | Default from CLI | Claude model to use |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | Define output format for agent results. See [Structured outputs](/docs/en/agent-sdk/structured-outputs) for details |
| `pathToClaudeCodeExecutable` | `string` | Uses built-in executable | Path to Claude Code executable |
| `permissionMode` | [`PermissionMode`](#permissionmode) | `'default'` | Permission mode for the session |
| `permissionPromptToolName` | `string` | `undefined` | MCP tool name for permission prompts |
| `plugins` | [`SdkPluginConfig`](#sdkpluginconfig)`[]` | `[]` | Load custom plugins from local paths. See [Plugins](/docs/en/agent-sdk/plugins) for details |
| `resume` | `string` | `undefined` | Session ID to resume |
| `resumeSessionAt` | `string` | `undefined` | Resume session at a specific message UUID |
| `sandbox` | [`SandboxSettings`](#sandboxsettings) | `undefined` | Configure sandbox behavior programmatically. See [Sandbox settings](#sandboxsettings) for details |
| `settingSources` | [`SettingSource`](#settingsource)`[]` | `[]` (no settings) | Control which filesystem settings to load. When omitted, no settings are loaded. **Note:** Must include `'project'` to load CLAUDE.md files |
| `stderr` | `(data: string) => void` | `undefined` | Callback for stderr output |
| `strictMcpConfig` | `boolean` | `false` | Enforce strict MCP validation |
| `systemPrompt` | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined` (empty prompt) | System prompt configuration. Pass a string for custom prompt, or `{ type: 'preset', preset: 'claude_code' }` to use Claude Code's system prompt. When using the preset object form, add `append` to extend the system prompt with additional instructions |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | `undefined` | Tool configuration. Pass an array of tool names or use the preset to get Claude Code's default tools |

### `Query`

Interface returned by the `query()` function.

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  rewindFiles(userMessageUuid: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
}
```

#### Methods

| Method | Description |
| :----- | :---------- |
| `interrupt()` | Interrupts the query (only available in streaming input mode) |
| `rewindFiles(userMessageUuid)` | Restores files to their state at the specified user message. Requires `enableFileCheckpointing: true`. See [File checkpointing](/docs/en/agent-sdk/file-checkpointing) |
| `setPermissionMode()` | Changes the permission mode (only available in streaming input mode) |
| `setModel()` | Changes the model (only available in streaming input mode) |
| `setMaxThinkingTokens()` | Changes the maximum thinking tokens (only available in streaming input mode) |
| `supportedCommands()` | Returns available slash commands |
| `supportedModels()` | Returns available models with display info |
| `mcpServerStatus()` | Returns status of connected MCP servers |
| `accountInfo()` | Returns account information |

### `AgentDefinition`

Configuration for a subagent defined programmatically.

```typescript
type AgentDefinition = {
  description: string;
  tools?: string[];
  prompt: string;
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

| Field | Required | Description |
|:------|:---------|:------------|
| `description` | Yes | Natural language description of when to use this agent |
| `tools` | No | Array of allowed tool names. If omitted, inherits all tools |
| `prompt` | Yes | The agent's system prompt |
| `model` | No | Model override for this agent. If omitted, uses the main model |

### `SettingSource`

Controls which filesystem-based configuration sources the SDK loads settings from.

```typescript
type SettingSource = 'user' | 'project' | 'local';
```

| Value | Description | Location |
|:------|:------------|:---------|
| `'user'` | Global user settings | `~/.claude/settings.json` |
| `'project'` | Shared project settings (version controlled) | `.claude/settings.json` |
| `'local'` | Local project settings (gitignored) | `.claude/settings.local.json` |

#### Default behavior

When `settingSources` is **omitted** or **undefined**, the SDK does **not** load any filesystem settings. This provides isolation for SDK applications.

#### Why use settingSources?

**Load all filesystem settings (legacy behavior):**
```typescript
// Load all settings like SDK v0.0.x did
const result = query({
  prompt: "Analyze this code",
  options: {
    settingSources: ['user', 'project', 'local']  // Load all settings
  }
});
```

**Load only specific setting sources:**
```typescript
// Load only project settings, ignore user and local
const result = query({
  prompt: "Run CI checks",
  options: {
    settingSources: ['project']  // Only .claude/settings.json
  }
});
```

**Testing and CI environments:**
```typescript
// Ensure consistent behavior in CI by excluding local settings
const result = query({
  prompt: "Run tests",
  options: {
    settingSources: ['project'],  // Only team-shared settings
    permissionMode: 'bypassPermissions'
  }
});
```

**SDK-only applications:**
```typescript
// Define everything programmatically (default behavior)
// No filesystem dependencies - settingSources defaults to []
const result = query({
  prompt: "Review this PR",
  options: {
    // settingSources: [] is the default, no need to specify
    agents: { /* ... */ },
    mcpServers: { /* ... */ },
    allowedTools: ['Read', 'Grep', 'Glob']
  }
});
```

**Loading CLAUDE.md project instructions:**
```typescript
// Load project settings to include CLAUDE.md files
const result = query({
  prompt: "Add a new feature following project conventions",
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code'  // Required to use CLAUDE.md
    },
    settingSources: ['project'],  // Loads CLAUDE.md from project directory
    allowedTools: ['Read', 'Write', 'Edit']
  }
});
```

#### Settings precedence

When multiple sources are loaded, settings are merged with this precedence (highest to lowest):
1. Local settings (`.claude/settings.local.json`)
2. Project settings (`.claude/settings.json`)
3. User settings (`~/.claude/settings.json`)

Programmatic options (like `agents`, `allowedTools`) always override filesystem settings.

### `PermissionMode`

```typescript
type PermissionMode =
  | 'default'           // Standard permission behavior
  | 'acceptEdits'       // Auto-accept file edits
  | 'bypassPermissions' // Bypass all permission checks
  | 'plan'              // Planning mode - no execution
```

### `CanUseTool`

Custom permission function type for controlling tool usage.

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

Result of a permission check.

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

Configuration for MCP servers.

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

Configuration for loading plugins in the SDK.

```typescript
type SdkPluginConfig = {
  type: 'local';
  path: string;
}
```

| Field | Type | Description |
|:------|:-----|:------------|
| `type` | `'local'` | Must be `'local'` (only local plugins currently supported) |
| `path` | `string` | Absolute or relative path to the plugin directory |

**Example:**
```typescript
plugins: [
  { type: 'local', path: './my-plugin' },
  { type: 'local', path: '/absolute/path/to/plugin' }
]
```

For complete information on creating and using plugins, see [Plugins](/docs/en/agent-sdk/plugins).

## Message Types

### `SDKMessage`

Union type of all possible messages returned by the query.

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

Assistant response message.

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // From Anthropic SDK
  parent_tool_use_id: string | null;
}
```

### `SDKUserMessage`

User input message.

```typescript
type SDKUserMessage = {
  type: 'user';
  uuid?: UUID;
  session_id: string;
  message: APIUserMessage; // From Anthropic SDK
  parent_tool_use_id: string | null;
}
```

### `SDKUserMessageReplay`

Replayed user message with required UUID.

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

Final result message.

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
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      structured_output?: unknown;
    }
  | {
      type: 'result';
      subtype:
        | 'error_max_turns'
        | 'error_during_execution'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries';
      uuid: UUID;
      session_id: string;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      total_cost_usd: number;
      usage: NonNullableUsage;
      modelUsage: { [modelName: string]: ModelUsage };
      permission_denials: SDKPermissionDenial[];
      errors: string[];
    }
```

### `SDKSystemMessage`

System initialization message.

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

Streaming partial message (only when `includePartialMessages` is true).

```typescript
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: RawMessageStreamEvent; // From Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
}
```

### `SDKCompactBoundaryMessage`

Message indicating a conversation compaction boundary.

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

Information about a denied tool use.

```typescript
type SDKPermissionDenial = {
  tool_name: string;
  tool_use_id: string;
  tool_input: ToolInput;
}
```

## Hook Types

For a comprehensive guide on using hooks with examples and common patterns, see the [Hooks guide](/docs/en/agent-sdk/hooks).

### `HookEvent`

Available hook events.

```typescript
type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest';
```

### `HookCallback`

Hook callback function type.

```typescript
type HookCallback = (
  input: HookInput, // Union of all hook input types
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### `HookCallbackMatcher`

Hook configuration with optional matcher.

```typescript
interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
}
```

### `HookInput`

Union type of all hook input types.

```typescript
type HookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | NotificationHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PermissionRequestHookInput;
```

### `BaseHookInput`

Base interface that all hook input types extend.

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
  tool_input: unknown;
}
```

#### `PostToolUseHookInput`

```typescript
type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
}
```

#### `PostToolUseFailureHookInput`

```typescript
type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: unknown;
  error: string;
  is_interrupt?: boolean;
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
  reason: ExitReason;  // String from EXIT_REASONS array
}
```

#### `StopHookInput`

```typescript
type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
}
```

#### `SubagentStartHookInput`

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
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

#### `PermissionRequestHookInput`

```typescript
type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];
}
```

### `HookJSONOutput`

Hook return value.

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
        updatedInput?: Record<string, unknown>;
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

## Tool Input Types

Documentation of input schemas for all built-in Claude Code tools. These types are exported from `@anthropic-ai/claude-agent-sdk` and can be used for type-safe tool interactions.

### `ToolInput`

**Note:** This is a documentation-only type for clarity. It represents the union of all tool input types.

```typescript
type ToolInput =
  | AgentInput
  | AskUserQuestionInput
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

**Tool name:** `Task`

```typescript
interface AgentInput {
  /**
   * A short (3-5 word) description of the task
   */
  description: string;
  /**
   * The task for the agent to perform
   */
  prompt: string;
  /**
   * The type of specialized agent to use for this task
   */
  subagent_type: string;
}
```

Launches a new agent to handle complex, multi-step tasks autonomously.

### AskUserQuestion

**Tool name:** `AskUserQuestion`

```typescript
interface AskUserQuestionInput {
  /**
   * Questions to ask the user (1-4 questions)
   */
  questions: Array<{
    /**
     * The complete question to ask the user. Should be clear, specific,
     * and end with a question mark.
     */
    question: string;
    /**
     * Very short label displayed as a chip/tag (max 12 chars).
     * Examples: "Auth method", "Library", "Approach"
     */
    header: string;
    /**
     * The available choices (2-4 options). An "Other" option is
     * automatically provided.
     */
    options: Array<{
      /**
       * Display text for this option (1-5 words)
       */
      label: string;
      /**
       * Explanation of what this option means
       */
      description: string;
    }>;
    /**
     * Set to true to allow multiple selections
     */
    multiSelect: boolean;
  }>;
  /**
   * User answers populated by the permission system.
   * Maps question text to selected option label(s).
   * Multi-select answers are comma-separated.
   */
  answers?: Record<string, string>;
}
```

Asks the user clarifying questions during execution. See [Handling the AskUserQuestion Tool](/docs/en/agent-sdk/permissions#handling-the-askuserquestion-tool) for usage details.

### Bash

**Tool name:** `Bash`

```typescript
interface BashInput {
  /**
   * The command to execute
   */
  command: string;
  /**
   * Optional timeout in milliseconds (max 600000)
   */
  timeout?: number;
  /**
   * Clear, concise description of what this command does in 5-10 words
   */
  description?: string;
  /**
   * Set to true to run this command in the background
   */
  run_in_background?: boolean;
}
```

Executes bash commands in a persistent shell session with optional timeout and background execution.

### BashOutput

**Tool name:** `BashOutput`

```typescript
interface BashOutputInput {
  /**
   * The ID of the background shell to retrieve output from
   */
  bash_id: string;
  /**
   * Optional regex to filter output lines
   */
  filter?: string;
}
```

Retrieves output from a running or completed background bash shell.

### Edit

**Tool name:** `Edit`

```typescript
interface FileEditInput {
  /**
   * The absolute path to the file to modify
   */
  file_path: string;
  /**
   * The text to replace
   */
  old_string: string;
  /**
   * The text to replace it with (must be different from old_string)
   */
  new_string: string;
  /**
   * Replace all occurrences of old_string (default false)
   */
  replace_all?: boolean;
}
```

Performs exact string replacements in files.

### Read

**Tool name:** `Read`

```typescript
interface FileReadInput {
  /**
   * The absolute path to the file to read
   */
  file_path: string;
  /**
   * The line number to start reading from
   */
  offset?: number;
  /**
   * The number of lines to read
   */
  limit?: number;
}
```

Reads files from the local filesystem, including text, images, PDFs, and Jupyter notebooks.

### Write

**Tool name:** `Write`

```typescript
interface FileWriteInput {
  /**
   * The absolute path to the file to write
   */
  file_path: string;
  /**
   * The content to write to the file
   */
  content: string;
}
```

Writes a file to the local filesystem, overwriting if it exists.

### Glob

**Tool name:** `Glob`

```typescript
interface GlobInput {
  /**
   * The glob pattern to match files against
   */
  pattern: string;
  /**
   * The directory to search in (defaults to cwd)
   */
  path?: string;
}
```

Fast file pattern matching that works with any codebase size.

### Grep

**Tool name:** `Grep`

```typescript
interface GrepInput {
  /**
   * The regular expression pattern to search for
   */
  pattern: string;
  /**
   * File or directory to search in (defaults to cwd)
   */
  path?: string;
  /**
   * Glob pattern to filter files (e.g. "*.js")
   */
  glob?: string;
  /**
   * File type to search (e.g. "js", "py", "rust")
   */
  type?: string;
  /**
   * Output mode: "content", "files_with_matches", or "count"
   */
  output_mode?: 'content' | 'files_with_matches' | 'count';
  /**
   * Case insensitive search
   */
  '-i'?: boolean;
  /**
   * Show line numbers (for content mode)
   */
  '-n'?: boolean;
  /**
   * Lines to show before each match
   */
  '-B'?: number;
  /**
   * Lines to show after each match
   */
  '-A'?: number;
  /**
   * Lines to show before and after each match
   */
  '-C'?: number;
  /**
   * Limit output to first N lines/entries
   */
  head_limit?: number;
  /**
   * Enable multiline mode
   */
  multiline?: boolean;
}
```

Powerful search tool built on ripgrep with regex support.

### KillBash

**Tool name:** `KillBash`

```typescript
interface KillShellInput {
  /**
   * The ID of the background shell to kill
   */
  shell_id: string;
}
```

Kills a running background bash shell by its ID.

### NotebookEdit

**Tool name:** `NotebookEdit`

```typescript
interface NotebookEditInput {
  /**
   * The absolute path to the Jupyter notebook file
   */
  notebook_path: string;
  /**
   * The ID of the cell to edit
   */
  cell_id?: string;
  /**
   * The new source for the cell
   */
  new_source: string;
  /**
   * The type of the cell (code or markdown)
   */
  cell_type?: 'code' | 'markdown';
  /**
   * The type of edit (replace, insert, delete)
   */
  edit_mode?: 'replace' | 'insert' | 'delete';
}
```

Edits cells in Jupyter notebook files.

### WebFetch

**Tool name:** `WebFetch`

```typescript
interface WebFetchInput {
  /**
   * The URL to fetch content from
   */
  url: string;
  /**
   * The prompt to run on the fetched content
   */
  prompt: string;
}
```

Fetches content from a URL and processes it with an AI model.

### WebSearch

**Tool name:** `WebSearch`

```typescript
interface WebSearchInput {
  /**
   * The search query to use
   */
  query: string;
  /**
   * Only include results from these domains
   */
  allowed_domains?: string[];
  /**
   * Never include results from these domains
   */
  blocked_domains?: string[];
}
```

Searches the web and returns formatted results.

### TodoWrite

**Tool name:** `TodoWrite`

```typescript
interface TodoWriteInput {
  /**
   * The updated todo list
   */
  todos: Array<{
    /**
     * The task description
     */
    content: string;
    /**
     * The task status
     */
    status: 'pending' | 'in_progress' | 'completed';
    /**
     * Active form of the task description
     */
    activeForm: string;
  }>;
}
```

Creates and manages a structured task list for tracking progress.

### ExitPlanMode

**Tool name:** `ExitPlanMode`

```typescript
interface ExitPlanModeInput {
  /**
   * The plan to run by the user for approval
   */
  plan: string;
}
```

Exits planning mode and prompts the user to approve the plan.

### ListMcpResources

**Tool name:** `ListMcpResources`

```typescript
interface ListMcpResourcesInput {
  /**
   * Optional server name to filter resources by
   */
  server?: string;
}
```

Lists available MCP resources from connected servers.

### ReadMcpResource

**Tool name:** `ReadMcpResource`

```typescript
interface ReadMcpResourceInput {
  /**
   * The MCP server name
   */
  server: string;
  /**
   * The resource URI to read
   */
  uri: string;
}
```

Reads a specific MCP resource from a server.

## Tool Output Types

Documentation of output schemas for all built-in Claude Code tools. These types represent the actual response data returned by each tool.

### `ToolOutput`

**Note:** This is a documentation-only type for clarity. It represents the union of all tool output types.

```typescript
type ToolOutput =
  | TaskOutput
  | AskUserQuestionOutput
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

**Tool name:** `Task`

```typescript
interface TaskOutput {
  /**
   * Final result message from the subagent
   */
  result: string;
  /**
   * Token usage statistics
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /**
   * Total cost in USD
   */
  total_cost_usd?: number;
  /**
   * Execution duration in milliseconds
   */
  duration_ms?: number;
}
```

Returns the final result from the subagent after completing the delegated task.

### AskUserQuestion

**Tool name:** `AskUserQuestion`

```typescript
interface AskUserQuestionOutput {
  /**
   * The questions that were asked
   */
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect: boolean;
  }>;
  /**
   * The answers provided by the user.
   * Maps question text to answer string.
   * Multi-select answers are comma-separated.
   */
  answers: Record<string, string>;
}
```

Returns the questions asked and the user's answers.

### Bash

**Tool name:** `Bash`

```typescript
interface BashOutput {
  /**
   * Combined stdout and stderr output
   */
  output: string;
  /**
   * Exit code of the command
   */
  exitCode: number;
  /**
   * Whether the command was killed due to timeout
   */
  killed?: boolean;
  /**
   * Shell ID for background processes
   */
  shellId?: string;
}
```

Returns command output with exit status. Background commands return immediately with a shellId.

### BashOutput

**Tool name:** `BashOutput`

```typescript
interface BashOutputToolOutput {
  /**
   * New output since last check
   */
  output: string;
  /**
   * Current shell status
   */
  status: 'running' | 'completed' | 'failed';
  /**
   * Exit code (when completed)
   */
  exitCode?: number;
}
```

Returns incremental output from background shells.

### Edit

**Tool name:** `Edit`

```typescript
interface EditOutput {
  /**
   * Confirmation message
   */
  message: string;
  /**
   * Number of replacements made
   */
  replacements: number;
  /**
   * File path that was edited
   */
  file_path: string;
}
```

Returns confirmation of successful edits with replacement count.

### Read

**Tool name:** `Read`

```typescript
type ReadOutput = 
  | TextFileOutput
  | ImageFileOutput
  | PDFFileOutput
  | NotebookFileOutput;

interface TextFileOutput {
  /**
   * File contents with line numbers
   */
  content: string;
  /**
   * Total number of lines in file
   */
  total_lines: number;
  /**
   * Lines actually returned
   */
  lines_returned: number;
}

interface ImageFileOutput {
  /**
   * Base64 encoded image data
   */
  image: string;
  /**
   * Image MIME type
   */
  mime_type: string;
  /**
   * File size in bytes
   */
  file_size: number;
}

interface PDFFileOutput {
  /**
   * Array of page contents
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
   * Total number of pages
   */
  total_pages: number;
}

interface NotebookFileOutput {
  /**
   * Jupyter notebook cells
   */
  cells: Array<{
    cell_type: 'code' | 'markdown';
    source: string;
    outputs?: any[];
    execution_count?: number;
  }>;
  /**
   * Notebook metadata
   */
  metadata?: Record<string, any>;
}
```

Returns file contents in format appropriate to file type.

### Write

**Tool name:** `Write`

```typescript
interface WriteOutput {
  /**
   * Success message
   */
  message: string;
  /**
   * Number of bytes written
   */
  bytes_written: number;
  /**
   * File path that was written
   */
  file_path: string;
}
```

Returns confirmation after successfully writing the file.

### Glob

**Tool name:** `Glob`

```typescript
interface GlobOutput {
  /**
   * Array of matching file paths
   */
  matches: string[];
  /**
   * Number of matches found
   */
  count: number;
  /**
   * Search directory used
   */
  search_path: string;
}
```

Returns file paths matching the glob pattern, sorted by modification time.

### Grep

**Tool name:** `Grep`

```typescript
type GrepOutput = 
  | GrepContentOutput
  | GrepFilesOutput
  | GrepCountOutput;

interface GrepContentOutput {
  /**
   * Matching lines with context
   */
  matches: Array<{
    file: string;
    line_number?: number;
    line: string;
    before_context?: string[];
    after_context?: string[];
  }>;
  /**
   * Total number of matches
   */
  total_matches: number;
}

interface GrepFilesOutput {
  /**
   * Files containing matches
   */
  files: string[];
  /**
   * Number of files with matches
   */
  count: number;
}

interface GrepCountOutput {
  /**
   * Match counts per file
   */
  counts: Array<{
    file: string;
    count: number;
  }>;
  /**
   * Total matches across all files
   */
  total: number;
}
```

Returns search results in the format specified by output_mode.

### KillBash

**Tool name:** `KillBash`

```typescript
interface KillBashOutput {
  /**
   * Success message
   */
  message: string;
  /**
   * ID of the killed shell
   */
  shell_id: string;
}
```

Returns confirmation after terminating the background shell.

### NotebookEdit

**Tool name:** `NotebookEdit`

```typescript
interface NotebookEditOutput {
  /**
   * Success message
   */
  message: string;
  /**
   * Type of edit performed
   */
  edit_type: 'replaced' | 'inserted' | 'deleted';
  /**
   * Cell ID that was affected
   */
  cell_id?: string;
  /**
   * Total cells in notebook after edit
   */
  total_cells: number;
}
```

Returns confirmation after modifying the Jupyter notebook.

### WebFetch

**Tool name:** `WebFetch`

```typescript
interface WebFetchOutput {
  /**
   * AI model's response to the prompt
   */
  response: string;
  /**
   * URL that was fetched
   */
  url: string;
  /**
   * Final URL after redirects
   */
  final_url?: string;
  /**
   * HTTP status code
   */
  status_code?: number;
}
```

Returns the AI's analysis of the fetched web content.

### WebSearch

**Tool name:** `WebSearch`

```typescript
interface WebSearchOutput {
  /**
   * Search results
   */
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    /**
     * Additional metadata if available
     */
    metadata?: Record<string, any>;
  }>;
  /**
   * Total number of results
   */
  total_results: number;
  /**
   * The query that was searched
   */
  query: string;
}
```

Returns formatted search results from the web.

### TodoWrite

**Tool name:** `TodoWrite`

```typescript
interface TodoWriteOutput {
  /**
   * Success message
   */
  message: string;
  /**
   * Current todo statistics
   */
  stats: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
  };
}
```

Returns confirmation with current task statistics.

### ExitPlanMode

**Tool name:** `ExitPlanMode`

```typescript
interface ExitPlanModeOutput {
  /**
   * Confirmation message
   */
  message: string;
  /**
   * Whether user approved the plan
   */
  approved?: boolean;
}
```

Returns confirmation after exiting plan mode.

### ListMcpResources

**Tool name:** `ListMcpResources`

```typescript
interface ListMcpResourcesOutput {
  /**
   * Available resources
   */
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    server: string;
  }>;
  /**
   * Total number of resources
   */
  total: number;
}
```

Returns list of available MCP resources.

### ReadMcpResource

**Tool name:** `ReadMcpResource`

```typescript
interface ReadMcpResourceOutput {
  /**
   * Resource contents
   */
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
  /**
   * Server that provided the resource
   */
  server: string;
}
```

Returns the contents of the requested MCP resource.

## Permission Types

### `PermissionUpdate`

Operations for updating permissions.

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
  | 'userSettings'     // Global user settings
  | 'projectSettings'  // Per-directory project settings
  | 'localSettings'    // Gitignored local settings
  | 'session'          // Current session only
```

### `PermissionRuleValue`

```typescript
type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
}
```

## Other Types

### `ApiKeySource`

```typescript
type ApiKeySource = 'user' | 'project' | 'org' | 'temporary';
```

### `SdkBeta`

Available beta features that can be enabled via the `betas` option. See [Beta headers](/docs/en/api/beta-headers) for more information.

```typescript
type SdkBeta = 'context-1m-2025-08-07';
```

| Value | Description | Compatible Models |
|:------|:------------|:------------------|
| `'context-1m-2025-08-07'` | Enables 1 million token [context window](/docs/en/build-with-claude/context-windows) | Claude Sonnet 4, Claude Sonnet 4.5 |

### `SlashCommand`

Information about an available slash command.

```typescript
type SlashCommand = {
  name: string;
  description: string;
  argumentHint: string;
}
```

### `ModelInfo`

Information about an available model.

```typescript
type ModelInfo = {
  value: string;
  displayName: string;
  description: string;
}
```

### `McpServerStatus`

Status of a connected MCP server.

```typescript
type McpServerStatus = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending';
  serverInfo?: {
    name: string;
    version: string;
  };
}
```

### `AccountInfo`

Account information for the authenticated user.

```typescript
type AccountInfo = {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}
```

### `ModelUsage`

Per-model usage statistics returned in result messages.

```typescript
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
}
```

### `ConfigScope`

```typescript
type ConfigScope = 'local' | 'user' | 'project';
```

### `NonNullableUsage`

A version of [`Usage`](#usage) with all nullable fields made non-nullable.

```typescript
type NonNullableUsage = {
  [K in keyof Usage]: NonNullable<Usage[K]>;
}
```

### `Usage`

Token usage statistics (from `@anthropic-ai/sdk`).

```typescript
type Usage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}
```

### `CallToolResult`

MCP tool result type (from `@modelcontextprotocol/sdk/types.js`).

```typescript
type CallToolResult = {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    // Additional fields vary by type
  }>;
  isError?: boolean;
}
```

### `AbortError`

Custom error class for abort operations.

```typescript
class AbortError extends Error {}
```

## Sandbox Configuration

### `SandboxSettings`

Configuration for sandbox behavior. Use this to enable command sandboxing and configure network restrictions programmatically.

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: NetworkSandboxSettings;
  ignoreViolations?: SandboxIgnoreViolations;
  enableWeakerNestedSandbox?: boolean;
}
```

| Property | Type | Default | Description |
| :------- | :--- | :------ | :---------- |
| `enabled` | `boolean` | `false` | Enable sandbox mode for command execution |
| `autoAllowBashIfSandboxed` | `boolean` | `false` | Auto-approve bash commands when sandbox is enabled |
| `excludedCommands` | `string[]` | `[]` | Commands that always bypass sandbox restrictions (e.g., `['docker']`). These run unsandboxed automatically without model involvement |
| `allowUnsandboxedCommands` | `boolean` | `false` | Allow the model to request running commands outside the sandbox. When `true`, the model can set `dangerouslyDisableSandbox` in tool input, which falls back to the [permissions system](#permissions-fallback-for-unsandboxed-commands) |
| `network` | [`NetworkSandboxSettings`](#networksandboxsettings) | `undefined` | Network-specific sandbox configuration |
| `ignoreViolations` | [`SandboxIgnoreViolations`](#sandboxignoreviolations) | `undefined` | Configure which sandbox violations to ignore |
| `enableWeakerNestedSandbox` | `boolean` | `false` | Enable a weaker nested sandbox for compatibility |

<Note>
**Filesystem and network access restrictions** are NOT configured via sandbox settings. Instead, they are derived from [permission rules](https://code.claude.com/docs/en/settings#permission-settings):

- **Filesystem read restrictions**: Read deny rules
- **Filesystem write restrictions**: Edit allow/deny rules
- **Network restrictions**: WebFetch allow/deny rules

Use sandbox settings for command execution sandboxing, and permission rules for filesystem and network access control.
</Note>

#### Example usage

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = await query({
  prompt: "Build and test my project",
  options: {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      excludedCommands: ["docker"],
      network: {
        allowLocalBinding: true,
        allowUnixSockets: ["/var/run/docker.sock"]
      }
    }
  }
});
```

### `NetworkSandboxSettings`

Network-specific configuration for sandbox mode.

```typescript
type NetworkSandboxSettings = {
  allowLocalBinding?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
}
```

| Property | Type | Default | Description |
| :------- | :--- | :------ | :---------- |
| `allowLocalBinding` | `boolean` | `false` | Allow processes to bind to local ports (e.g., for dev servers) |
| `allowUnixSockets` | `string[]` | `[]` | Unix socket paths that processes can access (e.g., Docker socket) |
| `allowAllUnixSockets` | `boolean` | `false` | Allow access to all Unix sockets |
| `httpProxyPort` | `number` | `undefined` | HTTP proxy port for network requests |
| `socksProxyPort` | `number` | `undefined` | SOCKS proxy port for network requests |

### `SandboxIgnoreViolations`

Configuration for ignoring specific sandbox violations.

```typescript
type SandboxIgnoreViolations = {
  file?: string[];
  network?: string[];
}
```

| Property | Type | Default | Description |
| :------- | :--- | :------ | :---------- |
| `file` | `string[]` | `[]` | File path patterns to ignore violations for |
| `network` | `string[]` | `[]` | Network patterns to ignore violations for |

### Permissions Fallback for Unsandboxed Commands

When `allowUnsandboxedCommands` is enabled, the model can request to run commands outside the sandbox by setting `dangerouslyDisableSandbox: true` in the tool input. These requests fall back to the existing permissions system, meaning your `canUseTool` handler will be invoked, allowing you to implement custom authorization logic.

<Note>
**`excludedCommands` vs `allowUnsandboxedCommands`:**
- `excludedCommands`: A static list of commands that always bypass the sandbox automatically (e.g., `['docker']`). The model has no control over this.
- `allowUnsandboxedCommands`: Lets the model decide at runtime whether to request unsandboxed execution by setting `dangerouslyDisableSandbox: true` in the tool input.
</Note>

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = await query({
  prompt: "Deploy my application",
  options: {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: true  // Model can request unsandboxed execution
    },
    permissionMode: "default",
    canUseTool: async (tool, input) => {
      // Check if the model is requesting to bypass the sandbox
      if (tool === "Bash" && input.dangerouslyDisableSandbox) {
        // The model wants to run this command outside the sandbox
        console.log(`Unsandboxed command requested: ${input.command}`);

        // Return true to allow, false to deny
        return isCommandAuthorized(input.command);
      }
      return true;
    }
  }
});
```

This pattern enables you to:

- **Audit model requests**: Log when the model requests unsandboxed execution
- **Implement allowlists**: Only permit specific commands to run unsandboxed
- **Add approval workflows**: Require explicit authorization for privileged operations

<Warning>
Commands running with `dangerouslyDisableSandbox: true` have full system access. Ensure your `canUseTool` handler validates these requests carefully.
</Warning>

## See also

- [SDK overview](/docs/en/agent-sdk/overview) - General SDK concepts
- [Python SDK reference](/docs/en/agent-sdk/python) - Python SDK documentation
- [CLI reference](https://code.claude.com/docs/en/cli-reference) - Command-line interface
- [Common workflows](https://code.claude.com/docs/en/common-workflows) - Step-by-step guides