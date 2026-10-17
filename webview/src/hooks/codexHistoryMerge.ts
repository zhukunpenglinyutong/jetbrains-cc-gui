import type { ClaudeMessage } from '../types';

/** Uses native identity instead of text, so identical prompts stay separate. */
export function codexHistoryIdentity(message: ClaudeMessage): string | undefined {
  const raw = message.raw;
  if (!raw || typeof raw !== 'object') return undefined;
  if (typeof raw.clientMessageId === 'string' && raw.clientMessageId) return `client:${raw.clientMessageId}`;
  if (typeof raw.codexItemId === 'string') {
    return `item:${raw.codexThreadId ?? ''}:${raw.codexTurnId ?? ''}:${raw.codexItemId}`;
  }
  return typeof raw.uuid === 'string' ? `uuid:${raw.uuid}` : undefined;
}

/** Keeps overlapping pages and uncertain local submissions without duplicating confirmed items. */
export function mergeCodexHistory(earlier: ClaudeMessage[], current: ClaudeMessage[]): ClaudeMessage[] {
  const result: ClaudeMessage[] = [];
  const positions = new Map<string, number>();
  for (const page of [earlier, current]) {
    for (const message of page) {
      const key = codexHistoryIdentity(message);
      const position = key ? positions.get(key) : undefined;
      if (position === undefined) {
        if (key) positions.set(key, result.length);
        result.push(message);
      } else {
        const previous = result[position];
        const previousItem = previous.raw && typeof previous.raw === 'object' ? previous.raw.codexItemId : undefined;
        const currentItem = message.raw && typeof message.raw === 'object' ? message.raw.codexItemId : undefined;
        if (!(previousItem && !currentItem)) result[position] = message;
      }
    }
  }
  return result;
}
