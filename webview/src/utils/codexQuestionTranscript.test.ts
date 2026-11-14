import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { CODEX_QUESTION_DISMISSED, projectCodexQuestionTranscript } from './codexQuestionTranscript';

const questions = [
  { id: 'question-1', question: 'Pick one.', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
  { id: 'question-2', question: 'Any comment?', options: [] },
];
const question = (thread = 'thread', itemId = 'question'): ClaudeMessage => ({ type: 'assistant', content: '', raw: {
  codexThreadId: thread, codexItemType: 'agentMessage', codexTurnId: 'turn', codexSnapshot: true,
  message: { content: [{ type: 'tool_use', id: itemId, name: 'codex_user_input', input: { questions } }] },
} });
const answer = (text = 'Answers to your questions:\n\nPick one.\nB\n\nAny comment?\nA custom\nmultiline answer', thread = 'thread'): ClaudeMessage => ({
  type: 'user', content: text, raw: { codexItemType: 'userMessage', codexThreadId: thread,
    message: { content: [{ type: 'text', text }] } },
});

describe('Codex question transcripts', () => {
  it('pairs Java rollout projections with raw.content and native question identities after a full history fallback', () => {
    const native = question();
    const reply = answer(answer().content!.replace('Answers to your questions:', 'Answers to your questions (request: question):'));
    if (!native.raw || typeof native.raw === 'string' || !reply.raw || typeof reply.raw === 'string') {
      throw new Error('Expected structured question and answer fixtures');
    }
    const legacyQuestion: ClaudeMessage = { ...native, raw: { ...native.raw,
      content: native.raw.message?.content, message: undefined } };
    const legacyReply: ClaudeMessage = { ...reply, raw: { ...reply.raw,
      content: reply.raw.message?.content, message: undefined } };
    const restored = projectCodexQuestionTranscript([legacyQuestion, legacyReply], new WeakMap());
    expect(restored).toHaveLength(1);
    expect(restored[0].raw).toMatchObject({ message: { content: [{ name: 'codex_user_input', input: { answers: {
      'question-1': 'B', 'question-2': 'A custom\nmultiline answer',
    } } }] } });
  });
  it.each([false, true])('pairs live/reloaded answers without mutating native persistence (reload=%s)', reload => {
    const original = [question(), answer()];
    const messages: ClaudeMessage[] = reload ? JSON.parse(JSON.stringify(original)) : original;
    const before = JSON.stringify(messages);
    const projected = projectCodexQuestionTranscript(messages, new WeakMap());
    expect(projected).toHaveLength(1);
    expect(projected[0].raw).toMatchObject({ message: { content: [{ input: { answers: {
      'question-1': 'B', 'question-2': 'A custom\nmultiline answer',
    } } }] } });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('preserves ordinary, malformed, cross-thread and uncorrelated answer text', () => {
    for (const message of [answer('Ordinary chat'), answer('Answers to your questions:\n\nDifferent question\nB'),
      answer(undefined, 'other-thread'), { ...answer(), raw: undefined }]) {
      const messages = [question(), message];
      expect(projectCodexQuestionTranscript(messages, new WeakMap())).toEqual(messages);
    }
    const messages = [answer()];
    expect(projectCodexQuestionTranscript(messages, new WeakMap())).toEqual(messages);
  });

  it('keeps unrelated streaming updates stable and pairs identical questions with the most recent request', () => {
    const old = question(); const recent = question(); const response = answer();
    const cache: Parameters<typeof projectCodexQuestionTranscript>[1] = new WeakMap();
    const first = projectCodexQuestionTranscript([old, recent, response], cache);
    const second = projectCodexQuestionTranscript([old, recent, response, { type: 'assistant', content: 'Next' }], cache);
    expect(first[0]).toBe(old);
    expect(first[1]).not.toBe(recent);
    expect(second[1]).toBe(first[1]);
  });

  it('pairs an optimistic late answer once and leaves later unrelated user input visible', () => {
    const late = { ...answer(), isOptimistic: true, raw: undefined };
    const ordinary = answer('Continue after answering.');
    const result = projectCodexQuestionTranscript([question(), late, ordinary], new WeakMap());
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(ordinary);
  });

  it('uses the native question item id when identical questions are pending', () => {
    const old = question(); const recent = question();
    recent.raw = { ...recent.raw as object, message: { content: [{ type: 'tool_use', id: 'new-question',
      name: 'codex_user_input', input: { questions } }] } };
    const reply = answer(answer().content!.replace('Answers to your questions:', 'Answers to your questions (request: question):'));
    const result = projectCodexQuestionTranscript([old, recent, reply], new WeakMap());
    expect(result).toHaveLength(2);
    expect(result[0]).not.toBe(old);
    expect(result[1]).toBe(recent);
    for (const id of ['unknown-question', '%invalid']) {
      const invalid = answer(reply.content!.replace('request: question', `request: ${id}`));
      expect(projectCodexQuestionTranscript([old, invalid], new WeakMap())).toEqual([old, invalid]);
    }
  });

  it('preserves opaque native request IDs containing parentheses and escaped characters', () => {
    const itemId = 'native)question/%\n中文';
    const reply = answer(answer().content!.replace('Answers to your questions:',
      `Answers to your questions (request: ${encodeURIComponent(itemId)}):`));
    const result = projectCodexQuestionTranscript([question('thread', itemId), reply], new WeakMap());
    expect(result).toHaveLength(1);
    expect(result[0].raw).toMatchObject({ message: { content: [{ input: { answers: { 'question-1': 'B' } } }] } });
  });

  it('pairs the notice for a dismissed question with that question', () => {
    const notice = `Answers to your questions (request: question):\n\nPick one.\n${CODEX_QUESTION_DISMISSED}`
      + `\n\nAny comment?\n${CODEX_QUESTION_DISMISSED}`;
    const result = projectCodexQuestionTranscript([question(), answer(notice)], new WeakMap());
    expect(result).toHaveLength(1);
    expect(result[0].raw).toMatchObject({ message: { content: [{ input: { answers: {
      'question-1': CODEX_QUESTION_DISMISSED, 'question-2': CODEX_QUESTION_DISMISSED,
    } } }] } });
  });

  it('matches the dismissal notice the bridge sends to Codex', () => {
    const bridgeSource = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),
      '../../../ai-bridge/services/codex/codex-async-questions.js'), 'utf8');
    expect(bridgeSource).toContain(`export const ASYNC_QUESTION_DISMISSED = '${CODEX_QUESTION_DISMISSED}';`);
  });
});
