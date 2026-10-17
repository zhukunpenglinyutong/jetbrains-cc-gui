import type { TFunction } from 'i18next';
import type { ToolInput } from '../types';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Only unwrap the launch envelope; the executed command remains available for inspection. */
function unwrapShellCommand(command: string): string {
  const launch = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/.exec(command);
  if (!launch) return command;
  const executable = (launch[1] || launch[2] || launch[3]).split(/[\\/]/).at(-1)?.toLowerCase();
  const argumentsText = launch[4];
  const wrapper = executable === 'pwsh' || executable === 'pwsh.exe'
    || executable === 'powershell' || executable === 'powershell.exe'
    ? /^(?:-(?:NoProfile|NonInteractive|NoLogo)\s+)*-(?:Command|c)\s+([\s\S]+)$/i.exec(argumentsText)
    : executable && ['bash', 'sh', 'zsh', 'bash.exe'].includes(executable)
      ? /^-(?:lc|cl|c)\s+([\s\S]+)$/.exec(argumentsText) : null;
  if (!wrapper) return command;
  const body = wrapper[1].trim();
  const quote = body[0];
  return (quote === '"' || quote === "'") && body.at(-1) === quote ? body.slice(1, -1) : body;
}

/** Native actions describe observable work; they do not explain the model's intent. */
export function presentCommand(input: ToolInput | undefined, t: TFunction) {
  const command = text(input?.command) || text(input?.cmd);
  const displayCommand = unwrapShellCommand(command);
  const explicit = text(input?.description) || text(input?.summary) || text(input?.title);
  const actions = Array.isArray(input?.commandActions) ? input.commandActions : [];
  const labels = actions.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const action = value as Record<string, unknown>;
    const path = text(action.path) || text(action.name);
    switch (action.type) {
      case 'read': return [t('tools.commandRead', { path })];
      case 'listFiles': return [t('tools.commandList', { path })];
      case 'search': return [t('tools.commandSearch', { query: text(action.query), path })];
      default: return [];
    }
  });
  const description = explicit && explicit !== command ? explicit
    : labels.length ? [...new Set(labels)].join(' · ') : displayCommand;
  const justification = text(input?.approvalReason) || text(input?.justification);
  return { command, displayCommand, description, justification };
}
