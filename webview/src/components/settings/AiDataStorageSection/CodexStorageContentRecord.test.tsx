import { describe, expect, it } from 'vitest';
import { readableStorageRecord } from './CodexStorageContentRecord';

describe('storage transcript presentation', () => {
  it.each([
    [{ type: 'userMessage', content: [{ type: 'text', text: 'Question' }] }, 'user', 'Question'],
    [{ type: 'agentMessage', text: 'Answer' }, 'assistant', 'Answer'],
    [{ type: 'event_msg', payload: { type: 'user_message', message: 'JSONL question' } }, 'user', 'JSONL question'],
    [{ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'JSONL answer' }] } }, 'assistant', 'JSONL answer'],
  ] as const)('extracts text and role from supported file and database records (%j)', (record, role, text) => {
    expect(readableStorageRecord(JSON.stringify(record))).toEqual({ role, text });
  });

  it.each(['{"type":"agentMessage","text":"truncated', '{"type":"session_meta","payload":{"id":"session"}}', 'plain text'])
    ('preserves unsupported or incomplete records for inspection (%s)', raw => {
      expect(readableStorageRecord(raw)).toEqual({ text: raw });
    });
});
