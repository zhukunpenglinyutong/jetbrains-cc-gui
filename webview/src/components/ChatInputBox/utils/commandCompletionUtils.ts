import type { CommandItem } from '../types.js';

const COMMAND_PLACEHOLDER_IDS = new Set(['__loading__', '__error__']);

/**
 * Loading/error rows share this prefix so the dropdown can disable them and
 * insertion can leave their i18n labels alone.
 */
export function isCommandPlaceholder(command: Pick<CommandItem, 'id'>): boolean {
  return COMMAND_PLACEHOLDER_IDS.has(command.id);
}

/**
 * Return the semantic content type of a command completion.
 *
 * The explicit field is preferred, while category and label keep older
 * provider payloads compatible with the Codex picker.
 */
export function getCommandContentType(
  command: Pick<CommandItem, 'contentType' | 'category' | 'label'>
): 'command' | 'skill' {
  if (command.contentType === 'skill' || command.contentType === 'command') {
    return command.contentType;
  }
  if (command.category?.toLowerCase() === 'skill' || command.label.trimStart().startsWith('$')) {
    return 'skill';
  }
  return 'command';
}

/**
 * Build the canonical / or $ label for a command completion.
 */
export function getCommandDisplayLabel(
  command: Pick<CommandItem, 'id' | 'contentType' | 'category' | 'label'>
): string {
  if (isCommandPlaceholder(command)) {
    return command.label;
  }
  const prefix = getCommandContentType(command) === 'skill' ? '$' : '/';
  const name = command.label.trim().replace(/^[/$]+/, '');
  return `${prefix}${name}`;
}

/**
 * Build the canonical text that should be inserted after a completion is selected.
 */
export function getCommandInsertionText(command: CommandItem): string {
  return `${getCommandDisplayLabel(command)} `;
}
