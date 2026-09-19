import type { CommandItem, DropdownItemData } from '../types.js';
import { dollarCommandProvider } from './dollarCommandProvider.js';
import { slashCommandProvider } from './slashCommandProvider.js';
import {
  getCommandContentType,
  getCommandDisplayLabel,
  isCommandPlaceholder,
} from '../utils/commandCompletionUtils.js';

function withUniqueCodexId(command: CommandItem): CommandItem {
  if (isCommandPlaceholder(command)) {
    return command;
  }
  return {
    ...command,
    id: `${getCommandContentType(command)}:${command.id}`,
  };
}

function mergeUniqueCandidates(candidates: CommandItem[]): CommandItem[] {
  const uniqueCandidates = new Map<string, CommandItem>();
  candidates.forEach(candidate => {
    if (!uniqueCandidates.has(candidate.id)) {
      uniqueCandidates.set(candidate.id, candidate);
    }
  });
  return [...uniqueCandidates.values()];
}

/**
 * Provide the shared Codex picker contents for both / and $ triggers.
 */
export async function codexCommandProvider(
  query: string,
  signal: AbortSignal
): Promise<CommandItem[]> {
  const [commands, skills] = await Promise.all([
    slashCommandProvider(query, signal),
    dollarCommandProvider(query, signal),
  ]);
  const candidates = mergeUniqueCandidates([...commands, ...skills]
    .filter(command => !isCommandPlaceholder(command))
    .map(withUniqueCodexId));
  if (candidates.length > 0) {
    return candidates;
  }

  const placeholder = [...commands, ...skills].find(isCommandPlaceholder);
  return placeholder ? [placeholder] : [];
}

/**
 * Render a Codex command or skill with its semantic icon and metadata.
 */
export function codexCommandToDropdownItem(command: CommandItem): DropdownItemData {
  const contentType = isCommandPlaceholder(command) ? undefined : getCommandContentType(command);
  return {
    id: command.id,
    label: getCommandDisplayLabel(command),
    description: command.description,
    icon: contentType === 'skill' ? 'codicon-symbol-event' : 'codicon-terminal',
    type: 'command',
    contentType,
    data: { command },
  };
}
