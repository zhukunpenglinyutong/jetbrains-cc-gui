import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { parseTaskNotificationXml, collectTaskEventsFromMessages } from './taskNotificationMessage';

// Mirrors the user-message content Claude Code injects when a background Agent
// terminates. The <result> body is escaped with Na() (only & < >).
const FULL_XML = `<task-notification>
<task-id>w-abc123</task-id>
<tool-use-id>toolu_01XYZ</tool-use-id>
<output-file>/home/user/.codemoss/agents/abc.jsonl</output-file>
<status>completed</status>
<summary>Agent "research" finished</summary>
<result>Found 3 issues &amp; fixed them. See &lt;report&gt; for details.</result>
</task-notification>`;

describe('parseTaskNotificationXml', () => {
  it('extracts fields, unescapes the result body, and prefers result over summary', () => {
    const event = parseTaskNotificationXml(FULL_XML);
    expect(event).toEqual({
      toolUseId: 'toolu_01XYZ',
      status: 'completed',
      agentId: 'w-abc123',
      summary: 'Found 3 issues & fixed them. See <report> for details.',
      outputFilePath: '/home/user/.codemoss/agents/abc.jsonl',
    });
  });

  it('falls back to the one-line summary when result is absent', () => {
    const xml = `<task-notification>
<tool-use-id>toolu_02</tool-use-id>
<status>failed</status>
<summary>Agent "y" failed: boom</summary>
</task-notification>`;
    expect(parseTaskNotificationXml(xml)).toEqual({
      toolUseId: 'toolu_02',
      status: 'failed',
      summary: 'Agent "y" failed: boom',
    });
  });

  it('maps killed status to stopped', () => {
    const xml = `<task-notification>\n<tool-use-id>t</tool-use-id>\n<status>killed</status>\n</task-notification>`;
    expect(parseTaskNotificationXml(xml)?.status).toBe('stopped');
  });

  it('returns null without a tool-use-id (unrouteable)', () => {
    const xml = `<task-notification>\n<task-id>w-1</task-id>\n<status>completed</status>\n</task-notification>`;
    expect(parseTaskNotificationXml(xml)).toBeNull();
  });

  it('returns null for a non-terminal status', () => {
    const xml = `<task-notification>\n<tool-use-id>t</tool-use-id>\n<status>running</status>\n</task-notification>`;
    expect(parseTaskNotificationXml(xml)).toBeNull();
  });

  it('returns null for a non-task-notification payload', () => {
    expect(parseTaskNotificationXml('just a user message')).toBeNull();
    expect(parseTaskNotificationXml('<command-message>run</command-message>')).toBeNull();
  });

  it('omits optional fields when the tags are absent', () => {
    const xml = `<task-notification>\n<tool-use-id>t</tool-use-id>\n<status>completed</status>\n</task-notification>`;
    const event = parseTaskNotificationXml(xml);
    expect(event).toEqual({ toolUseId: 't', status: 'completed' });
    expect(event && 'summary' in event).toBe(false);
  });
});

describe('collectTaskEventsFromMessages', () => {
  function user(content: string): ClaudeMessage {
    return { type: 'user', content };
  }

  it('collects a task event from a task-notification user message', () => {
    const derived = collectTaskEventsFromMessages([user(FULL_XML)]);
    expect(derived.toolu_01XYZ).toEqual({
      toolUseId: 'toolu_01XYZ',
      status: 'completed',
      agentId: 'w-abc123',
      summary: 'Found 3 issues & fixed them. See <report> for details.',
      outputFilePath: '/home/user/.codemoss/agents/abc.jsonl',
    });
  });

  it('skips non-user messages and ordinary user messages', () => {
    const messages: ClaudeMessage[] = [
      { type: 'assistant', content: 'thinking...' },
      user('please review the JSON files'),
      { type: 'task_notification', icon: '✓', summary: 'done', status: 'completed' },
    ];
    expect(collectTaskEventsFromMessages(messages)).toEqual({});
  });

  it('keys multiple task-notifications by their tool-use-id', () => {
    const messages: ClaudeMessage[] = [
      user(FULL_XML),
      user(`<task-notification>\n<tool-use-id>toolu_99</tool-use-id>\n<status>stopped</status>\n</task-notification>`),
    ];
    const derived = collectTaskEventsFromMessages(messages);
    expect(Object.keys(derived).sort()).toEqual(['toolu_01XYZ', 'toolu_99']);
  });
});
