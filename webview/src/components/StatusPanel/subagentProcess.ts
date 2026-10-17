import type { SubagentHistoryResponse } from '../../types';

export interface SubagentProcessModel {
  notes: string[];
  readFiles: string[];
  toolCalls: Array<{ id: string; name: string; detail?: string }>;
  resultText?: string;
}

export function formatSubagentDuration(
  totalDurationMs?: number,
  units?: { ms?: string; s?: string },
): string | null {
  if (typeof totalDurationMs !== 'number') return null;
  const msLabel = units?.ms ?? 'ms';
  const sLabel = units?.s ?? 's';
  if (totalDurationMs < 1000) return `${totalDurationMs}${msLabel}`;
  return `${(totalDurationMs / 1000).toFixed(1)}${sLabel}`;
}

function getRawContent(message: unknown): unknown[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const frontendRaw = record.raw && typeof record.raw === 'object'
    ? record.raw as Record<string, unknown>
    : undefined;
  const nestedMessage = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : undefined;
  const content = frontendRaw?.content ?? (frontendRaw?.message as Record<string, unknown> | undefined)?.content
    ?? nestedMessage?.content ?? record.content;
  return Array.isArray(content) ? content : [];
}

function getToolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const filePath = record.file_path ?? record.path;
  if (typeof filePath === 'string') return filePath;
  const command = record.command ?? record.cmd;
  if (typeof command === 'string') return command;
  const pattern = record.pattern;
  if (typeof pattern === 'string') return pattern;
  return undefined;
}

function compactPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 4 ? `…/${parts.slice(-4).join('/')}` : path;
}

function pushUnique(list: string[], value: string) {
  if (!list.includes(value)) list.push(value);
}

export function buildSubagentProcessModel(history?: SubagentHistoryResponse): SubagentProcessModel {
  const model: SubagentProcessModel = { notes: [], readFiles: [], toolCalls: [] };
  if (!history?.success || !Array.isArray(history.messages)) return model;
  let lastText: string | undefined;
  let finalAnswer: string | undefined;

  history.messages.forEach((message, messageIndex) => {
    const raw = message && typeof message === 'object' ? message as Record<string, any> : {};
    const nativeTurnId = raw.raw?.codexTurnId ?? raw.codexTurnId;
    const isLatestTurn = !history.latestTurnId || typeof nativeTurnId !== 'string' || nativeTurnId === history.latestTurnId;
    // A previous final_answer must not outrank the current turn's unphased report.
    if (history.completed && raw.type === 'assistant' && isLatestTurn) {
      const text = getRawContent(message).flatMap(block => block && typeof block === 'object'
        && (block as Record<string, unknown>).type === 'text' && typeof (block as Record<string, unknown>).text === 'string'
        ? [(block as { text: string }).text] : []).join('\n').trim();
      if (text) {
        lastText = text;
        if ((raw.raw?.codexPhase ?? raw.codexPhase) === 'final_answer') finalAnswer = text;
      }
    }
    getRawContent(message).forEach((block, blockIndex) => {
      if (!block || typeof block !== 'object') return;
      const item = block as Record<string, any>;
      if (item.type === 'thinking'
        && raw.type === 'assistant'
        && typeof item.thinking === 'string'
        && item.thinking.trim()) {
        // The "thought" section must show the agent's actual reasoning, not
        // its output. A sidechain transcript's assistant messages carry
        // thinking blocks throughout and a single final text block with the
        // terminal report — collecting text here would surface the report in
        // the thought section, duplicating the result section.
        model.notes.push(item.thinking.trim());
        return;
      }
      if (item.type !== 'tool_use') return;

      const name = typeof item.name === 'string' ? item.name : 'Tool';
      const detail = getToolDetail(item.input);
      if (name.toLowerCase() === 'read' && detail) {
        pushUnique(model.readFiles, compactPath(detail));
        return;
      }
      model.toolCalls.push({
        id: `${messageIndex}-${blockIndex}`,
        name,
        detail: detail ? compactPath(detail) : undefined,
      });
    });
  });
  if (finalAnswer || lastText) model.resultText = finalAnswer ?? lastText;

  return model;
}
