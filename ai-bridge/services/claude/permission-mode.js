import { canUseTool, requestPlanApproval, READ_ONLY_TOOLS } from '../../permission-handler.js';

const ACCEPT_EDITS_AUTO_APPROVE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'CreateDirectory',
  'MoveFile',
  'CopyFile',
  'Rename'
]);

const PLAN_MODE_ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'TodoWrite', 'Skill', 'TaskOutput',
  'Task',
  'Write',
  'Edit',
  'Bash',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'mcp__ace-tool__search_context',
  'mcp__context7__resolve-library-id',
  'mcp__context7__query-docs',
  'mcp__conductor__GetWorkspaceDiff',
  'mcp__conductor__GetTerminalOutput',
  'mcp__conductor__AskUserQuestion',
  'mcp__conductor__DiffComment',
  'mcp__time__get_current_time',
  'mcp__time__convert_time'
]);

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

export function shouldAutoApproveTool(permissionMode, toolName) {
  if (!toolName) return false;
  if (INTERACTIVE_TOOLS.has(toolName)) return false;
  if (permissionMode === 'bypassPermissions') return true;
  if (permissionMode === 'acceptEdits') {
    return ACCEPT_EDITS_AUTO_APPROVE_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName);
  }
  return false;
}

export function createPreToolUseHook(permissionModeState) {
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

  return async (input) => {
    let currentPermissionMode = readPermissionMode();
    const toolName = input?.tool_name;

    if (currentPermissionMode === 'plan') {
      if (toolName === 'AskUserQuestion') {
        return { decision: 'approve' };
      }

      if (toolName === 'Edit' || toolName === 'Bash') {
        try {
          const result = await canUseTool(toolName, input?.tool_input);
          if (result?.behavior === 'allow') {
            return { decision: 'approve', updatedInput: result.updatedInput ?? input?.tool_input };
          }
          return {
            decision: 'block',
            reason: result?.message || 'Permission denied'
          };
        } catch (error) {
          return {
            decision: 'block',
            reason: 'Permission check failed: ' + (error?.message || String(error))
          };
        }
      }

      if (toolName === 'ExitPlanMode') {
        try {
          const result = await requestPlanApproval(input?.tool_input);
          if (result?.approved) {
            const nextMode = result.targetMode || 'default';
            currentPermissionMode = nextMode;
            if (permissionModeState && typeof permissionModeState === 'object') {
              permissionModeState.value = nextMode;
            }
            return {
              decision: 'approve',
              updatedInput: {
                ...input.tool_input,
                approved: true,
                targetMode: nextMode
              }
            };
          }
          return {
            decision: 'block',
            reason: result?.message || 'Plan was rejected by user'
          };
        } catch (error) {
          return {
            decision: 'block',
            reason: 'Plan approval failed: ' + (error?.message || String(error))
          };
        }
      }

      if (PLAN_MODE_ALLOWED_TOOLS.has(toolName)) {
        return { decision: 'approve' };
      }

      if (toolName?.startsWith('mcp__') && !toolName.includes('Write') && !toolName.includes('Edit')) {
        return { decision: 'approve' };
      }

      return {
        decision: 'block',
        reason: `Tool "${toolName}" is not allowed in plan mode. Only read-only tools are permitted.`
      };
    }

    if (toolName === 'AskUserQuestion') {
      return { decision: 'approve' };
    }

    if (shouldAutoApproveTool(currentPermissionMode, toolName)) {
      return { decision: 'approve' };
    }

    try {
      const result = await canUseTool(toolName, input?.tool_input);
      if (result?.behavior === 'allow') {
        if (result?.updatedInput !== undefined) {
          return { decision: 'approve', updatedInput: result.updatedInput };
        }
        return { decision: 'approve' };
      }
      if (result?.behavior === 'deny') {
        return {
          decision: 'block',
          reason: result?.message || 'Permission denied'
        };
      }
      return {};
    } catch (error) {
      return {
        decision: 'block',
        reason: 'Permission check failed: ' + (error?.message || String(error))
      };
    }
  };
}
