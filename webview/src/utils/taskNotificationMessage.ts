import type { ClaudeMessage, TaskEvent, TaskEventMap, TaskEventStatus } from '../types';

// Recent Claude Code terminates a background Agent by injecting a
// <task-notification> XML as the content of a plain user message in the main
// session — NOT as a queued_command attachment and NOT as a task_notification
// SDK system event. The XML's <result> tag is the only place the agent's full
// report lives, so without parsing it the subagent card stays stuck on the
// launch ack text. This marker is the cheapest possible reject for non-carriers.
const TASK_NOTIFICATION_MARKER = '<task-notification>';

const STATUS_ALIASES: Record<string, TaskEventStatus> = { killed: 'stopped' };
const VALID_TERMINAL_STATUSES = new Set<TaskEventStatus>(['completed', 'failed', 'stopped']);

function extractTag(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return undefined;
  const contentStart = start + open.length;
  const end = xml.indexOf(`</${tag}>`, contentStart);
  if (end < 0) return undefined;
  return unescapeXml(xml.slice(contentStart, end));
}

// Claude Code's Na() escapes only & < >, but the envelope may carry &quot;/
// &apos;. &amp; is decoded last so it cannot half-decode the others mid-flight.
function unescapeXml(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * Parse a task-notification XML string into a {@link TaskEvent}, mirroring the
 * SDK's emitTaskTerminatedSdk shape so the existing taskEvents consumers
 * (useSubagents, AgentGroupBlock, TaskExecutionBlock) need no changes. The full
 * <result> report is preferred over the one-line <summary>. Returns null when
 * the payload lacks a tool_use_id or carries a non-terminal status, so a
 * non-terminal or malformed envelope is ignored rather than producing an event
 * the downstream dedup would reject anyway.
 */
export function parseTaskNotificationXml(xml: string): TaskEvent | null {
  const toolUseId = extractTag(xml, 'tool-use-id');
  if (!toolUseId) return null;
  const rawStatus = extractTag(xml, 'status');
  if (!rawStatus) return null;
  const status = STATUS_ALIASES[rawStatus] ?? rawStatus;
  if (!VALID_TERMINAL_STATUSES.has(status)) return null;
  const agentId = extractTag(xml, 'task-id');
  const report = extractTag(xml, 'result') || extractTag(xml, 'summary');
  const outputFile = extractTag(xml, 'output-file');
  const event: TaskEvent = { toolUseId, status };
  if (agentId) event.agentId = agentId;
  if (report) event.summary = report;
  if (outputFile) event.outputFilePath = outputFile;
  return event;
}

/**
 * Scan the main-session message list and build a tool_use_id -> TaskEvent map
 * from any task-notification user messages. This is the recovery path for the
 * recent Claude Code behavior where a background agent's terminal report is
 * delivered as a user message rather than an SDK event — it covers both history
 * replay (no live SDK stream) and any live session where the SDK event path did
 * not fire. Callers merge this into the live taskEvents map without overwriting
 * entries already supplied by a real SDK event.
 */
export function collectTaskEventsFromMessages(messages: ClaudeMessage[]): TaskEventMap {
  const derived: TaskEventMap = {};
  for (const message of messages) {
    if (message.type !== 'user') continue;
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content.includes(TASK_NOTIFICATION_MARKER)) continue;
    const event = parseTaskNotificationXml(content);
    if (event) derived[event.toolUseId] = event;
  }
  return derived;
}
