import { canUseTool, requestPlanApproval, READ_ONLY_TOOLS, SAFE_ALWAYS_ALLOW_TOOLS, EDIT_TOOLS } from '../../permission-handler.js';
import { debugLog } from '../../permission-ipc.js';
import { isAcceptEditsAllowed } from '../../permission-safety.js';

/**
 * Tools auto-approved in acceptEdits mode.
 * Includes all edit/write tools plus read-only tools.
 * Matches CLI's acceptEdits mode behavior:
 * - File edit operations in working directory
 * - All read-only operations
 */
const ACCEPT_EDITS_AUTO_APPROVE_TOOLS = new Set([
  // File modification tools
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'CreateDirectory',
  'MoveFile',
  'CopyFile',
  'Rename',
]);

/**
 * Plan mode allowed tools.
 * In plan mode, only read-only/exploration tools and specific planning tools are allowed.
 * Write/Edit/Bash are NOT in this list — they go through canUseTool for explicit permission.
 *
 * Matches CLI behavior:
 * - SAFE_ALWAYS_ALLOW_TOOLS are auto-approved (handled before this check)
 * - WebFetch/WebSearch are allowed for exploration (read-only in practice)
 * - Write/Edit require canUseTool (plan file writes only)
 * - Bash requires canUseTool
 * - ExitPlanMode triggers plan approval dialog
 */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  // Read-only tools (not in SAFE_ALWAYS_ALLOW_TOOLS but safe for exploration)
  'WebFetch', 'WebSearch',
  // MCP read-only
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  // Specific MCP tools commonly used in exploration
  'mcp__ace-tool__search_context',
  'mcp__context7__resolve-library-id',
  'mcp__context7__query-docs',
  'mcp__conductor__GetWorkspaceDiff',
  'mcp__conductor__GetTerminalOutput',
  'mcp__conductor__AskUserQuestion',
  'mcp__conductor__DiffComment',
  'mcp__time__get_current_time',
  'mcp__time__convert_time',
]);

const PLAN_FILE_NAME = 'PLAN.md';

function isPlanFilePath(filePath, cwd) {
  if (!filePath || typeof filePath !== 'string') return false;
  const workingDir = cwd || process.cwd();
  // Normalize separators but preserve case for directory comparison (Linux is case-sensitive)
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedCwd = workingDir.replace(/\\/g, '/');
  // Only compare filename case-insensitively (PLAN.md, plan.md, Plan.md are all valid)
  const fileName = normalizedPath.split('/').pop() || '';
  if (fileName.toLowerCase() !== 'plan.md') return false;
  // Check if the file is in the project root (CWD)
  if (normalizedPath.startsWith(normalizedCwd + '/') || normalizedPath.startsWith(normalizedCwd)) return true;
  if (!normalizedPath.includes('/')) return true; // Relative path like "PLAN.md"
  return false;
}

/**
 * Extract all file paths from a tool's input.
 * MultiEdit may have multiple edits targeting different files.
 */
function extractFilePaths(toolName, toolInput) {
  if (!toolInput) return [];
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    return toolInput.edits
      .map(e => e.file_path || e.path)
      .filter(Boolean);
  }
  const fp = toolInput.file_path || toolInput.path;
  return fp ? [fp] : [];
}

const INTERACTIVE_TOOLS = new Set(['AskUserQuestion']);
const VALID_PERMISSION_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

export {
  ACCEPT_EDITS_AUTO_APPROVE_TOOLS,
  PLAN_MODE_ALLOWED_TOOLS,
  INTERACTIVE_TOOLS,
  VALID_PERMISSION_MODES
};

export function normalizePermissionMode(permissionMode) {
  if (!permissionMode || permissionMode === '') return 'default';
  if (VALID_PERMISSION_MODES.has(permissionMode)) return permissionMode;
  console.warn('[DAEMON] Unknown permission mode, falling back to default:', permissionMode);
  return 'default';
}

/**
 * Determines if a tool should be auto-approved based on the current permission mode.
 * Matches CLI's permission flow:
 * 1. SAFE_ALWAYS_ALLOW_TOOLS — always approved in any mode (checked first in preToolUseHook)
 * 2. bypassPermissions — everything approved
 * 3. acceptEdits — READ_ONLY tools approved; EDIT tools need CWD path check (done in hook)
 * 4. default — nothing auto-approved (goes to canUseTool)
 *
 * NOTE: This function cannot check file paths, so acceptEdits edit tools are NOT
 * auto-approved here. The hook must call shouldAcceptEditsTool() with the file path.
 */
export function shouldAutoApproveTool(permissionMode, toolName) {
  if (!toolName) return false;

  // Safe tools are always auto-approved regardless of mode
  // (This covers TodoWrite, Task*, AskUserQuestion, EnterPlanMode, ExitPlanMode,
  //  Glob, Grep, Read, LSP, ToolSearch, SendMessage, Sleep, etc.)
  // NOTE: WebFetch, WebSearch, Skill, Cron*, Worktree tools are NOT here —
  // they have their own permission checks in CLI and go through canUseTool.
  if (SAFE_ALWAYS_ALLOW_TOOLS.has(toolName)) return true;

  // bypassPermissions mode: everything is approved
  if (permissionMode === 'bypassPermissions') return true;

  // acceptEdits mode: only read-only tools are auto-approved here.
  // Edit tools require CWD path checking — handled separately in the hook.
  if (permissionMode === 'acceptEdits') {
    return READ_ONLY_TOOLS.has(toolName);
  }

  return false;
}

/**
 * Check if an edit tool should be auto-approved in acceptEdits mode.
 * Validates that the file path is within CWD and passes safety checks.
 * Matches CLI's checkWritePermissionForTool (filesystem.ts:1360-1375).
 * @param {string} toolName - Tool name
 * @param {Object} toolInput - Tool input parameters
 * @param {string} cwd - Working directory
 * @returns {boolean}
 */
export function shouldAcceptEditsTool(toolName, toolInput, cwd) {
  if (!ACCEPT_EDITS_AUTO_APPROVE_TOOLS.has(toolName)) return false;
  const filePath = toolInput?.file_path || toolInput?.path;
  if (!filePath) return true; // Tools like CreateDirectory without explicit path
  return isAcceptEditsAllowed(filePath, cwd);
}

export function createPreToolUseHook(permissionModeState, cwd = null, onModeChange = null) {
  const workingDirectory = cwd || process.cwd();
  const readPermissionMode = () => {
    if (permissionModeState && typeof permissionModeState === 'object') {
      const normalized = normalizePermissionMode(permissionModeState.value);
      if (permissionModeState.value !== normalized) {
        permissionModeState.value = normalized;
      }
      return normalized;
    }
    return normalizePermissionMode(permissionModeState);
  };
  const updatePermissionMode = async (mode) => {
    const normalized = normalizePermissionMode(mode);
    if (permissionModeState && typeof permissionModeState === 'object') {
      permissionModeState.value = normalized;
    }
    if (typeof onModeChange === 'function') {
      await onModeChange(normalized);
    }
    return normalized;
  };

  return async (input) => {
    let currentPermissionMode = readPermissionMode();
    const toolName = input?.tool_name;

    debugLog('PERMISSION_HOOK', `Called for tool: ${toolName}, mode: ${currentPermissionMode}`);

    // ======== HANDLE EnterPlanMode - update permissionModeState ========
    // When EnterPlanMode is called, we need to switch to plan mode for subsequent tools
    if (toolName === 'EnterPlanMode') {
      debugLog('PERMISSION_HOOK', 'EnterPlanMode called, switching to plan mode');
      currentPermissionMode = await updatePermissionMode('plan');
      // Auto-allow EnterPlanMode (it's in SAFE_ALWAYS_ALLOW_TOOLS)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow'
        }
      };
    }

    // ======== PLAN MODE ========
    if (currentPermissionMode === 'plan') {
      // Step 1: ExitPlanMode triggers plan approval dialog (must check BEFORE safe tools
      // because ExitPlanMode is in SAFE_ALWAYS_ALLOW_TOOLS but needs special handling here)
      if (toolName === 'ExitPlanMode') {
        try {
          const result = await requestPlanApproval(input?.tool_input);
          if (result?.approved) {
            const nextMode = result.targetMode || 'default';
            currentPermissionMode = await updatePermissionMode(nextMode);
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: {
                  ...input.tool_input,
                  approved: true,
                  targetMode: nextMode
                }
              }
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: result?.message || 'Plan was rejected by user'
          };
        } catch (error) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: 'Plan approval failed: ' + (error?.message || String(error))
          };
        }
      }

      // Step 2: Safe always-allow tools are auto-approved (includes AskUserQuestion,
      // TodoWrite, Task*, EnterPlanMode, Glob, Grep, Read, LSP, etc.
      // NOTE: WebFetch/WebSearch/Skill are NOT here — they go through plan mode allowed or canUseTool)
      if (SAFE_ALWAYS_ALLOW_TOOLS.has(toolName)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      }

      // Step 3: Agent/Task are auto-approved in plan mode, matching CLI behavior.
      if (toolName === 'Agent' || toolName === 'Task') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      }

      // Step 4: Edit/Write tools allow PLAN.md only; other writes require permission.
      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' ||
          toolName === 'NotebookEdit') {
        // MultiEdit may contain multiple file paths — check ALL of them
        const filePaths = extractFilePaths(toolName, input?.tool_input);
        const allArePlanFiles = filePaths.length > 0 &&
          filePaths.every(fp => isPlanFilePath(fp, workingDirectory));
        if (allArePlanFiles) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow'
            }
          };
        }
        try {
          const result = await canUseTool(toolName, input?.tool_input);
          if (result?.behavior === 'allow') {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: result.updatedInput ?? input?.tool_input
              }
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: result?.message || `Cannot edit non-plan files in plan mode. Only ${PLAN_FILE_NAME} can be edited.`
          };
        } catch (error) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: 'Permission check failed: ' + (error?.message || String(error))
          };
        }
      }

      if (toolName === 'Bash') {
        try {
          const result = await canUseTool(toolName, input?.tool_input);
          if (result?.behavior === 'allow') {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                updatedInput: result.updatedInput ?? input?.tool_input
              }
            };
          }
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: result?.message || 'Permission denied'
          };
        } catch (error) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny'
            },
            reason: 'Permission check failed: ' + (error?.message || String(error))
          };
        }
      }

      // Step 5: Plan mode specific allowed tools (read-only exploration tools)
      if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      }

      // Step 6: Auto-approve read-only MCP tools (mcp__* without Write/Edit in name)
      if (toolName?.startsWith('mcp__') && !toolName.includes('Write') && !toolName.includes('Edit')) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow'
          }
        };
      }

      // Everything else is blocked in plan mode
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny'
        },
        reason: `Tool "${toolName}" is not allowed in plan mode. Only read-only tools are permitted.`
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'continue'
      }
    };
  };
}
