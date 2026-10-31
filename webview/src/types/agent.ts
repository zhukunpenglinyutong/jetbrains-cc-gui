/**
 * Agent configuration
 *
 * The four original fields (id, name, prompt, createdAt) are unchanged and stay
 * backward compatible: existing store entries in ~/.codemoss/agent.json contain
 * only those, and older plugin versions must keep reading them.
 *
 * The specification fields below mirror the Claude Code subagent frontmatter
 * documented at code.claude.com/docs/en/claude-directory ("Frontmatter fields by
 * file", row `agents/*.md`). Every one of them is optional, because a
 * hand-written agent file may set any subset.
 */

/** Model identifier as accepted by the specification: `sonnet`, `haiku`, `inherit`, a full model id, … */
export type AgentModel = string;

/** Permission mode as accepted by the specification. */
export type AgentPermissionMode = string;

/** Persistent memory scope. */
export type AgentMemoryScope = 'user' | 'project' | 'local';

/** Effort level. Levels available depend on the model. */
export type AgentEffort = string | number;

/** Display color, when the frontmatter names one. */
export type AgentColor = string;

/**
 * Discovery scope of an agent:
 * - `global`: discovered in ~/.claude/agents
 * - `local`: discovered in {workspace}/.claude/agents
 * - `store`: the plugin's own editable copy in ~/.codemoss/agent.json
 */
export type AgentScope = 'global' | 'local' | 'store';

/**
 * Agent configuration
 */
export interface AgentConfig {
  /** Unique identifier */
  id: string;
  /** Agent name. No length limit; see {@link AgentFields} for the naming rules. */
  name: string;
  /** Prompt (max 100000 characters) */
  prompt?: string;
  /** Creation timestamp */
  createdAt?: number;

  // ---- Claude Code subagent specification fields (all optional) ----

  /** When Claude should delegate to this subagent. Required by the spec, optional here for legacy entries. */
  description?: string;
  /** Tools the agent may use, as a list. Inherits every available tool when omitted. */
  tools?: string[];
  /** Tools to remove from the inherited or specified list. */
  disallowedTools?: string[];
  /** Model to use, e.g. `sonnet` or `inherit`. */
  model?: AgentModel;
  /** Permission mode for the agent. */
  permissionMode?: AgentPermissionMode;
  /** Maximum number of agentic turns before the agent stops. */
  maxTurns?: number;
  /** Skills preloaded into the agent's context at startup. */
  skills?: string[];
  /** MCP servers available to this agent, by name or inline definition. */
  mcpServers?: Array<string | Record<string, unknown>>;
  /** Lifecycle hooks scoped to this agent. */
  hooks?: Record<string, unknown>;
  /** Persistent memory scope. */
  memory?: AgentMemoryScope;
  /** Keep the agent in the background even when asked to run in the foreground. */
  background?: boolean;
  /** Effort level while this agent is active. */
  effort?: AgentEffort;
  /** `worktree` to run the agent in an isolated git worktree. */
  isolation?: string;
  /** Display color for the agent in the task list. */
  color?: AgentColor;
  /** Auto-submitted as the first user turn when the agent runs as the main session agent. */
  initialPrompt?: string;
  /** Launch the agent without loading the CLAUDE.md files. */
  omitClaudeMd?: boolean;
  /** Map of experimental options, e.g. `{ cacheTtl: '5m' }`. */
  experimental?: Record<string, unknown>;

  // ---- Discovery metadata ----

  /** Absolute path of the backing .md file. Absent for store agents. */
  path?: string;
  /** Where the agent came from. */
  scope?: AgentScope;
  /** Origin marker, currently mirrors the scope for store entries. */
  source?: AgentScope | string;
  /** True for file-backed agents, which the plugin never writes to. */
  readOnly?: boolean;
  /** Why the agent could not be loaded fully, when applicable. */
  warning?: string;
  /**
   * 1-based line in the backing file that {@link warning} refers to.
   *
   * The backend resolves this from the parser's own mark, so it points at the
   * offending line rather than at where reading happened to stop. Absent when
   * the problem has no single location — a missing `name`, say — because a line
   * number pointing at something irrelevant is worse than none.
   */
  warningLine?: number;

  // ---- Deny visibility (computed server-side, never persisted) ----

  /**
   * True when a `permissions.deny` entry in an applicable `.claude/settings.json`
   * names this agent. Display-only: the plugin never edits settings, and the
   * flag is recomputed on every `get_agents`.
   */
  disabled?: boolean;
  /** Human-readable explanation shown next to {@link disabled}. */
  disabledReason?: string;
}

/**
 * The Claude Code subagent specification field set, in documented order.
 * Mirrors `AgentFields.SPECIFICATION_FIELDS` on the Java side; a vitest case
 * keeps the two lists in step.
 */
export const AGENT_SPECIFICATION_FIELDS = [
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
  'omitClaudeMd',
  'experimental',
] as const;

/** Discovery metadata fields added alongside the specification fields. */
export const AGENT_DISCOVERY_FIELDS = [
  'path',
  'scope',
  'source',
  'readOnly',
  'warning',
] as const;

/** Every known discovery scope. */
export const AGENT_SCOPES: readonly AgentScope[] = ['global', 'local', 'store'] as const;

/** Hyphen-case, per the specification's own examples (`code-reviewer`, `reviewer-v2`). */
const HYPHEN_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Check whether a name deviates from the hyphen-case convention.
 *
 * A non-blocking warning rather than a rejection: the specification documents no
 * such requirement, and real stores contain names like "New Agent". Callers use
 * this to explain the deviation, never to drop the agent.
 */
export function isNonHyphenCaseName(name: string | undefined | null): boolean {
  if (!name) return false;
  return !HYPHEN_CASE.test(name.trim());
}

/**
 * Check whether a name is a valid agent identifier.
 *
 * The specification forbids only `:` (reserved for plugin-scoped identifiers such
 * as `my-plugin:reviewer`). There is no length limit — the former 20-character cap
 * rejected 16 real agents and was removed.
 */
export function isValidAgentName(name: string | undefined | null): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  return trimmed.length > 0 && !/[:\r\n]/.test(trimmed);
}

/**
 * Check whether a value is a known discovery scope.
 */
export function isAgentScope(value: unknown): value is AgentScope {
  return typeof value === 'string' && (AGENT_SCOPES as readonly string[]).includes(value);
}

/**
 * Whether the tab may edit this agent.
 *
 * File-backed agents are never editable: the plugin does not write to
 * `~/.claude/agents` or a project `.claude/agents`, so an edit control there
 * could only produce a promise it cannot keep. An agent with no explicit
 * `readOnly` is a legacy store entry, which has always been editable.
 */
export function isAgentEditable(agent: AgentConfig): boolean {
  return agent.readOnly !== true;
}

/**
 * Agent operation result
 */
export interface AgentOperationResult {
  success: boolean;
  operation: 'add' | 'update' | 'delete';
  error?: string;
}

/**
 * Body of a `get_agents` request.
 *
 * The backend is the single source of truth for resolution: it merges the
 * store, `~/.claude/agents` and `{workspace}/.claude/agents`, applies
 * precedence (local > global > store, the winner taken whole) and answers with
 * a flat array. The client only says which scopes it wants to display.
 *
 * The body is optional. A request with no body means "every scope", so clients
 * that never learned this contract — the chat-bar provider among them — keep
 * working unchanged.
 */
export interface GetAgentsMessage {
  /** Scopes to return. Omit, or send an empty list, for all of them. */
  scopes?: AgentScope[];
}
