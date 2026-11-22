import type { ClaudeMessage, ClaudeRawMessage, ToolInput } from '../types';

/**
 * The answer the bridge records for a question the user closed without answering.
 * Must match ASYNC_QUESTION_DISMISSED in ai-bridge/services/codex/codex-async-questions.js.
 */
export const CODEX_QUESTION_DISMISSED = 'No answer: the user dismissed this question. Continue without waiting for it.';

export interface TranscriptQuestion {
  id: string;
  question: string;
  options: { label: string; description?: string }[];
}

export function transcriptQuestions(input: ToolInput | undefined): TranscriptQuestion[] {
  if (!Array.isArray(input?.questions)) return [];
  return input.questions.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object') return [];
    const question = value as Record<string, unknown>;
    if (typeof question.id !== 'string' || typeof question.question !== 'string') return [];
    return [{ id: question.id, question: question.question,
      options: Array.isArray(question.options) ? question.options.flatMap((option: unknown) => {
        if (!option || typeof option !== 'object' || !('label' in option) || typeof option.label !== 'string') return [];
        const description = 'description' in option && typeof option.description === 'string' ? option.description : undefined;
        return [{ label: option.label, ...(description !== undefined ? { description } : {}) }];
      }) : [] }];
  });
}

function rawBlocks(raw: ClaudeRawMessage | undefined) {
  const content = raw?.message?.content ?? raw?.content;
  return Array.isArray(content) ? content : [];
}

/** Match only a native question's exact answer envelope; ordinary chat stays intact. */
function parseAnswer(text: string, questions: TranscriptQuestion[], itemId: string): Record<string, string> | null {
  const envelope = /^Answers to your questions(?: \(request: ([^\r\n]*)\))?:\n\n/.exec(text);
  if (!envelope) return null;
  if (envelope[1] !== undefined) {
    try { if (decodeURIComponent(envelope[1]) !== itemId) return null; } catch { return null; }
  }
  let rest = text.slice(envelope[0].length);
  const answers: Record<string, string> = {};
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const heading = `${question.question}\n`;
    if (!rest.startsWith(heading)) return null;
    rest = rest.slice(heading.length);
    const next = questions[index + 1];
    const end = next ? rest.indexOf(`\n\n${next.question}\n`) : rest.length;
    if (end < 0 || !rest.slice(0, end).trim()) return null;
    answers[question.id] = rest.slice(0, end);
    rest = next ? rest.slice(end + 2) : '';
  }
  return rest === '' ? answers : null;
}

type Projection = { signature: string; message: ClaudeMessage };

/** Keep native persistence untouched and render live/reloaded answers beside their questions. */
export function projectCodexQuestionTranscript(messages: ClaudeMessage[], cache: WeakMap<ClaudeMessage, Projection>) {
  const pending: { message: ClaudeMessage; thread: unknown; id: string; questions: TranscriptQuestion[] }[] = [];
  const replacements = new Map<ClaudeMessage, ClaudeMessage>();
  const consumed = new Set<ClaudeMessage>();
  for (const message of messages) {
    const raw = typeof message.raw === 'object' && message.raw !== null ? message.raw : undefined;
    for (const block of rawBlocks(raw)) {
      if (block.type !== 'tool_use' || block.name !== 'codex_user_input' || !block.id) continue;
      const questions = transcriptQuestions(block.input);
      if (questions.length) pending.push({ message, thread: raw?.codexThreadId, id: block.id, questions });
    }
    if (message.type !== 'user' || (!message.isOptimistic && raw?.codexItemType !== 'userMessage'
      && raw?.codexItemType !== 'user_message')) continue;
    const text = rawBlocks(raw).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
      || message.content || '';
    for (let index = pending.length - 1; index >= 0; index--) {
      const question = pending[index];
      if (raw?.codexThreadId && raw.codexThreadId !== question.thread) continue;
      const answers = parseAnswer(text, question.questions, question.id);
      if (!answers) continue;
      const signature = JSON.stringify(answers);
      let projected = cache.get(question.message);
      if (projected?.signature !== signature) {
        const questionRaw = question.message.raw as ClaudeRawMessage;
        const content = rawBlocks(questionRaw).map(block => block.type === 'tool_use' && block.id === question.id
          ? { ...block, input: { ...block.input, answers } } : block);
        projected = { signature, message: { ...question.message,
          raw: { ...questionRaw, message: { ...questionRaw.message, content } } } };
        cache.set(question.message, projected);
      }
      replacements.set(question.message, projected.message);
      consumed.add(message);
      pending.splice(index, 1);
      break;
    }
  }
  return messages.filter(message => !consumed.has(message)).map(message => replacements.get(message) ?? message);
}
