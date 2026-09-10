import type { ToolInput } from '../../types';
import type { TFunction } from 'i18next';
import { truncate, truncatePathFromStart } from '../../utils/helpers';
import { isCommandToolName, parseCommandType } from '../../utils/toolCommandPath';
import {
  extractPathsFromPatch,
  summarizeToolCommand,
  type ToolTargetInfo,
} from '../../utils/toolPresentation';

const CODICON_MAP: Record<string, string> = {
  read: 'codicon-eye',
  edit: 'codicon-edit',
  write: 'codicon-pencil',
  bash: 'codicon-terminal',
  grep: 'codicon-search',
  glob: 'codicon-folder',
  task: 'codicon-tools',
  webfetch: 'codicon-globe',
  websearch: 'codicon-search',
  delete: 'codicon-trash',
  augmentcontextengine: 'codicon-symbol-class', // Added based on Picture 2
  update_plan: 'codicon-checklist', // Update plan tool
  shell_command: 'codicon-terminal', // Shell command tool
  shell_command_read: 'codicon-eye',
  shell_command_list: 'codicon-folder',
  shell_command_search: 'codicon-search',
};

export const getToolDisplayName = (t: TFunction, name?: string, input?: ToolInput) => {
  if (!name) {
    return t('tools.toolCall');
  }

  const lowerName = name.toLowerCase();

  // Codex uses 'cmd', others use 'command'
  const commandStr = (input?.command as string | undefined) ?? (input?.cmd as string | undefined);

  // For command-executing tools, check the actual command to determine display name
  if (isCommandToolName(lowerName) && commandStr) {
    const parsed = parseCommandType(commandStr);
    switch (parsed.type) {
      case 'read':
        return t('tools.readFile');
      case 'list':
        return t('tools.listFiles');
      case 'search':
        return t('tools.search');
      default:
        return t('tools.runCommand');
    }
  }

  // Translation key mapping
  const toolKeyMap: Record<string, string> = {
    'augmentcontextengine': 'tools.contextEngine',
    'task': 'tools.task',
    'read': 'tools.readFile',
    'read_file': 'tools.readFile',
    'edit': 'tools.editFile',
    'edit_file': 'tools.editFile',
    'write': 'tools.writeFile',
    'write_to_file': 'tools.writeFile',
    'replace_string': 'tools.replaceString',
    'search_replace': 'tools.replaceString',
    'searchreplace': 'tools.replaceString',
    'str_replace': 'tools.replaceString',
    'strreplace': 'tools.replaceString',
    'bash': 'tools.runCommand',
    'run_terminal_cmd': 'tools.runCommand',
    'execute_command': 'tools.executeCommand',
    'executecommand': 'tools.executeCommand',
    'shell_command': 'tools.runCommand',
    'grep': 'tools.search',
    'glob': 'tools.fileMatch',
    'webfetch': 'tools.webFetch',
    'websearch': 'tools.webSearch',
    'delete': 'tools.delete',
    'explore': 'tools.explore',
    'createdirectory': 'tools.createDirectory',
    'movefile': 'tools.moveFile',
    'copyfile': 'tools.copyFile',
    'list': 'tools.listFiles',
    'search': 'tools.search',
    'find': 'tools.findFile',
    'todowrite': 'tools.todoList',
    'update_plan': 'tools.updatePlan',
    'apply_patch': 'tools.applyPatch',
  };

  if (toolKeyMap[lowerName]) {
    return t(toolKeyMap[lowerName]);
  }

  // If it's snake_case, replace underscores with spaces and capitalize
  if (name.includes('_')) {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  // If it's CamelCase (starts with uppercase), split by capital letters
  // e.g. WebSearch -> Web Search
  if (/^[A-Z]/.test(name)) {
    return name.replace(/([A-Z])/g, ' $1').trim();
  }

  return name;
};

export const getToolCodicon = (name?: string, input?: ToolInput): string => {
  const lowerName = (name ?? '').toLowerCase();
  const commandStr = (input?.command as string | undefined) ?? (input?.cmd as string | undefined);

  if (isCommandToolName(lowerName) && commandStr) {
    const parsed = parseCommandType(commandStr);
    switch (parsed.type) {
      case 'read':
        return CODICON_MAP.shell_command_read ?? CODICON_MAP.shell_command;
      case 'list':
        return CODICON_MAP.shell_command_list ?? CODICON_MAP.shell_command;
      case 'search':
        return CODICON_MAP.shell_command_search ?? CODICON_MAP.shell_command;
      default:
        return CODICON_MAP.shell_command;
    }
  }

  return CODICON_MAP[lowerName] ?? 'codicon-tools';
};

// cmd: Codex uses 'cmd' instead of 'command'; description/workdir: Codex fields
const OMIT_FIELDS: Record<string, true> = {
  file_path: true,
  path: true,
  target_file: true,
  notebook_path: true,
  command: true,
  cmd: true,
  search_term: true,
  description: true,
  workdir: true,
  yield_time_ms: true,
  max_output_tokens: true,
};

export const getOtherParams = (input: ToolInput): [string, unknown][] =>
  Object.entries(input).filter(
    ([key]) => !OMIT_FIELDS[key] && key !== 'pattern',
  );

export const resolveToolSummary = (
  input: ToolInput,
  target: ToolTargetInfo | undefined,
  commandStr: string | undefined,
): string | null => {
  if (target) {
    return target.cleanFileName || target.displayPath;
  }
  if (commandStr) {
    const parsed = parseCommandType(commandStr);
    if (parsed.type === 'read' && parsed.path) {
      const pathParts = parsed.path.split('/');
      return pathParts[pathParts.length - 1] || truncatePathFromStart(parsed.path);
    }
    return summarizeToolCommand(commandStr) ?? truncate(commandStr);
  }
  if (typeof input.search_term === 'string') {
    return truncate(input.search_term);
  }
  if (typeof input.pattern === 'string') {
    return truncate(input.pattern);
  }
  return null;
};

export const extractPatchFiles = (lowerName: string, input: ToolInput): string[] => {
  const patchContent = lowerName === 'apply_patch'
    ? ((typeof input.input === 'string' ? input.input : undefined) ??
       (typeof input.patch === 'string' ? input.patch : undefined) ??
       (typeof input.content === 'string' ? input.content : undefined))
    : undefined;
  return patchContent ? extractPathsFromPatch(patchContent) : [];
};
