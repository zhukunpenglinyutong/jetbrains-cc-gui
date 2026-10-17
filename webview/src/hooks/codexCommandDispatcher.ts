/**
 * Classifies Codex slash commands before a message enters the provider queue.
 * Keeping this table pure lets the input box and programmatic send path share
 * exactly one dispatch decision and prevents a control command being sent twice.
 */

export type CodexCommandKind =
  | 'new'
  | 'resume'
  | 'plan'
  | 'compact'
  | 'review'
  | 'diff'
  | 'approvals'
  | 'init'
  | 'unknown';

export interface CodexCommand {
  command: string;
  kind: CodexCommandKind;
  argumentsText: string;
  body: string;
  hasArguments: boolean;
}

export const CODEX_COMMAND_CAPABILITIES: Readonly<Record<string, CodexCommandKind>> = Object.freeze({
  '/new': 'new',
  '/clear': 'new',
  '/reset': 'new',
  '/resume': 'resume',
  '/continue': 'resume',
  '/plan': 'plan',
  '/compact': 'compact',
  '/review': 'review',
  '/diff': 'diff',
  '/approvals': 'approvals',
  '/init': 'init',
});

/** Parse one command without deciding whether the active provider supports it. */
export function parseCodexCommand(text: string): CodexCommand | null {
  if (typeof text !== 'string' || !text.trim().startsWith('/')) {
    return null;
  }
  const normalized = text.trim();
  const firstWhitespace = normalized.search(/\s/);
  const command = (firstWhitespace < 0
    ? normalized
    : normalized.slice(0, firstWhitespace)).toLowerCase();
  const argumentsText = firstWhitespace < 0
    ? ''
    : normalized.slice(firstWhitespace).trim();
  const kind = CODEX_COMMAND_CAPABILITIES[command] ?? 'unknown';
  return {
    command,
    kind,
    argumentsText,
    body: kind === 'plan' || kind === 'init' ? argumentsText : '',
    hasArguments: argumentsText.length > 0,
  };
}
