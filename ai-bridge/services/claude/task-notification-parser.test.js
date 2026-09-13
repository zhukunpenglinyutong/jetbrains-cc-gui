import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskNotificationXml, buildTaskNotificationEvent, extractTaskNotificationXml } from './task-notification-parser.js';

// Mirrors the user-message content Claude Code injects when a background Agent
// terminates (built by enqueueAgentNotification). The <result> body is escaped
// with a minimal escaper (only & < >), so &amp;/&lt; appear inline.
const FULL_XML = `<task-notification>
<task-id>w-abc123</task-id>
<tool-use-id>toolu_01XYZ</tool-use-id>
<output-file>/home/user/.codemoss/agents/abc.jsonl</output-file>
<status>completed</status>
<summary>Agent "research" finished</summary>
<note>A task-notification fires each time this agent stops with no live background children of its own.</note>
<result>Found 3 issues &amp; fixed them. See &lt;report&gt; for details.</result>
</task-notification>`;

test('parseTaskNotificationXml extracts every field and unescapes the result body', () => {
  const parsed = parseTaskNotificationXml(FULL_XML);
  assert.deepEqual(parsed, {
    taskId: 'w-abc123',
    toolUseId: 'toolu_01XYZ',
    taskType: undefined,
    outputFile: '/home/user/.codemoss/agents/abc.jsonl',
    status: 'completed',
    summary: 'Agent "research" finished',
    result: 'Found 3 issues & fixed them. See <report> for details.',
  });
});

test('parseTaskNotificationXml leaves result undefined when the tag is absent', () => {
  // A task that produced no finalMessage omits <result> entirely (enqueueAgent
  // Notification builds the tag conditionally). The parser must surface that as
  // undefined, not an empty string, so buildTaskNotificationEvent can fall back
  // to the one-line summary.
  const xml = `<task-notification>
<tool-use-id>toolu_02</tool-use-id>
<status>completed</status>
<summary>Agent "x" finished</summary>
</task-notification>`;
  const parsed = parseTaskNotificationXml(xml);
  assert.strictEqual(parsed.result, undefined);
  assert.strictEqual(parsed.summary, 'Agent "x" finished');
});

test('parseTaskNotificationXml returns null without a tool-use-id', () => {
  // tool_use_id routes the event to a subagent card; without it the event is
  // unrouteable, so drop the payload rather than emit a dangling event.
  const xml = `<task-notification>
<task-id>w-1</task-id>
<status>completed</status>
</task-notification>`;
  assert.strictEqual(parseTaskNotificationXml(xml), null);
});

test('parseTaskNotificationXml returns null for non-task-notification payloads', () => {
  // A stray queued_command (e.g. a user prompt) must never yield a bogus event.
  assert.strictEqual(parseTaskNotificationXml('just a user message'), null);
  assert.strictEqual(parseTaskNotificationXml('<command-message>run</command-message>'), null);
});

test('parseTaskNotificationXml returns null for non-string input', () => {
  assert.strictEqual(parseTaskNotificationXml(null), null);
  assert.strictEqual(parseTaskNotificationXml(undefined), null);
  assert.strictEqual(parseTaskNotificationXml(42), null);
  assert.strictEqual(parseTaskNotificationXml({ prompt: 'x' }), null);
});

test('parseTaskNotificationXml accepts an array prompt by rejecting it', () => {
  // queued_command.prompt is usually a string but may be a content-block array;
  // the parser must not crash, just decline to parse.
  assert.strictEqual(parseTaskNotificationXml([{ type: 'text', text: 'x' }]), null);
});

test('buildTaskNotificationEvent prefers the full result over the one-line summary', () => {
  const event = buildTaskNotificationEvent(parseTaskNotificationXml(FULL_XML));
  // The frontend reads `summary` as resultText, so putting the full report here
  // is what surfaces it in the subagent card instead of "Agent ... finished".
  assert.strictEqual(event.summary, 'Found 3 issues & fixed them. See <report> for details.');
  assert.strictEqual(event.type, 'system');
  assert.strictEqual(event.subtype, 'task_notification');
  assert.strictEqual(event.tool_use_id, 'toolu_01XYZ');
  assert.strictEqual(event.status, 'completed');
  assert.strictEqual(event.task_id, 'w-abc123');
  assert.strictEqual(event.output_file, '/home/user/.codemoss/agents/abc.jsonl');
});

test('buildTaskNotificationEvent falls back to summary when result is absent', () => {
  const xml = `<task-notification>
<tool-use-id>toolu_03</tool-use-id>
<status>failed</status>
<summary>Agent "y" failed: boom</summary>
</task-notification>`;
  const event = buildTaskNotificationEvent(parseTaskNotificationXml(xml));
  assert.strictEqual(event.summary, 'Agent "y" failed: boom');
  assert.strictEqual(event.status, 'failed');
});

test('buildTaskNotificationEvent maps killed status to stopped', () => {
  // print.ts maps XML 'killed' -> 'stopped'; mirror that so the frontend's
  // terminal-status enum (completed/failed/stopped) accepts the event.
  const xml = `<task-notification>
<tool-use-id>toolu_04</tool-use-id>
<status>killed</status>
</task-notification>`;
  const event = buildTaskNotificationEvent(parseTaskNotificationXml(xml));
  assert.strictEqual(event.status, 'stopped');
});

test('buildTaskNotificationEvent rejects non-terminal statuses', () => {
  // A non-terminal or malformed status must not produce an event that
  // parseTaskNotification (frontend) would reject downstream anyway.
  const xml = `<task-notification>
<tool-use-id>toolu_05</tool-use-id>
<status>running</status>
</task-notification>`;
  assert.strictEqual(buildTaskNotificationEvent(parseTaskNotificationXml(xml)), null);
});

test('buildTaskNotificationEvent returns null for a null parsed payload', () => {
  assert.strictEqual(buildTaskNotificationEvent(null), null);
});

test('buildTaskNotificationEvent omits summary when both result and summary are absent', () => {
  const xml = `<task-notification>
<tool-use-id>toolu_06</tool-use-id>
<status>completed</status>
</task-notification>`;
  const event = buildTaskNotificationEvent(parseTaskNotificationXml(xml));
  // No summary key at all, so the frontend falls all the way back to the
  // launch ack text rather than rendering an empty report.
  assert.strictEqual('summary' in event, false);
});

test('extractTaskNotificationXml recognizes a queued_command attachment carrier', () => {
  // Claude Code sometimes delivers the report as a queued_command attachment
  // (attachment.commandMode === 'task-notification', XML in attachment.prompt)
  // rather than a user message. Both carriers must be recognized or the report
  // is lost on one path.
  const msg = {
    type: 'attachment',
    attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: FULL_XML },
  };
  assert.strictEqual(extractTaskNotificationXml(msg), FULL_XML);
});

test('extractTaskNotificationXml recognizes a user-message carrier', () => {
  const msg = { type: 'user', message: { role: 'user', content: FULL_XML } };
  assert.strictEqual(extractTaskNotificationXml(msg), FULL_XML);
  // Array-of-text-blocks content form is also accepted.
  const arrayMsg = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: FULL_XML }] },
  };
  assert.strictEqual(extractTaskNotificationXml(arrayMsg), FULL_XML);
});

test('extractTaskNotificationXml rejects non-carriers', () => {
  // A queued_command that is NOT a task-notification (e.g. an enqueued user
  // prompt) must not be mistaken for one.
  assert.strictEqual(extractTaskNotificationXml(null), null);
  assert.strictEqual(extractTaskNotificationXml({ type: 'assistant', message: { content: 'hi' } }), null);
  assert.strictEqual(
    extractTaskNotificationXml({
      type: 'attachment',
      attachment: { type: 'queued_command', commandMode: 'user-prompt', prompt: 'do something' },
    }),
    null,
  );
  assert.strictEqual(
    extractTaskNotificationXml({ type: 'user', message: { role: 'user', content: 'a normal prompt' } }),
    null,
  );
});
