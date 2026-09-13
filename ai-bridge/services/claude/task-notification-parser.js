/**
 * Parse a Claude Code task-notification XML string.
 *
 * Recent Claude Code terminates a background (run_in_background) Agent by
 * injecting a <task-notification> XML into the main session instead of
 * emitting a task_notification SDK event. The XML's <result> tag carries the
 * agent's finalMessage (its full report); the <summary> tag is only a one-liner
 * like `Agent "desc" finished`. Without parsing this XML the frontend subagent
 * card never sees the report and stays stuck on the launch ack text ("Async
 * agent launched successfully.").
 *
 * The carrier varies by Claude Code version/scene: the XML arrives either as
 * the content of a plain user message, or wrapped in a queued_command
 * attachment (attachment.type === 'queued_command', commandMode ===
 * 'task-notification', XML in attachment.prompt). extractTaskNotificationXml
 * recognizes both.
 *
 * The XML body is escaped with a minimal escaper (only & < >), so a
 * non-greedy indexOf scan for the closing tag is safe — the escaped report
 * text cannot contain a real `</result>`.
 */

export function parseTaskNotificationXml(xml) {
  if (typeof xml !== 'string') return null;
  // Reject non-task-notification payloads early so a stray queued_command
  // (e.g. a user prompt enqueued as an attachment) never yields a bogus event.
  if (!xml.includes('<task-notification')) return null;

  const toolUseId = extractTag(xml, 'tool-use-id');
  // tool_use_id is the only field the downstream dedup/routing depends on;
  // without it the event cannot be matched to a subagent card, so drop it.
  if (!toolUseId) return null;

  return {
    taskId: extractTag(xml, 'task-id'),
    toolUseId,
    taskType: extractTag(xml, 'task-type'),
    outputFile: extractTag(xml, 'output-file'),
    status: extractTag(xml, 'status'),
    summary: extractTag(xml, 'summary'),
    result: extractTag(xml, 'result'),
  };
}

/**
 * If `msg` carries a <task-notification> XML, return that XML string; otherwise
 * return null. Two carriers are recognized:
 *  - a main-session user message whose content is the XML (string, or an array
 *    of text blocks joined);
 *  - a queued_command attachment (attachment.type === 'queued_command',
 *    commandMode === 'task-notification') with the XML in attachment.prompt.
 * Both forms appear in the wild depending on Claude Code version/scene, so the
 * caller must handle both or the report is lost on one path. Returning null for
 * "not a carrier" lets the caller keep processing a normal user message
 * (in-turn) or silently consume it (inter-turn) without conflating it with an
 * unparseable payload.
 */
export function extractTaskNotificationXml(msg) {
  if (!msg) return null;
  if (msg.type === 'user') {
    const rawContent = msg.message?.content ?? msg.content;
    const xml = typeof rawContent === 'string' ? rawContent
      : (Array.isArray(rawContent)
        ? rawContent.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('')
        : '');
    return xml.includes('<task-notification') ? xml : null;
  }
  if (msg.type === 'attachment'
    && msg.attachment?.type === 'queued_command'
    && msg.attachment?.commandMode === 'task-notification'
    && typeof msg.attachment?.prompt === 'string'
    && msg.attachment.prompt.includes('<task-notification')) {
    return msg.attachment.prompt;
  }
  return null;
}

function extractTag(xml, tag) {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return undefined;
  const contentStart = start + open.length;
  const end = xml.indexOf(`</${tag}>`, contentStart);
  if (end < 0) return undefined;
  return unescapeXml(xml.slice(contentStart, end));
}

function unescapeXml(s) {
  // Na() only escapes & < >, but Claude Code uses &quot;/&apos; elsewhere in
  // the envelope. Unescape every named entity that is actually present;
  // &amp; must go last so it does not half-decode the others mid-flight.
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

const STATUS_ALIASES = { killed: 'stopped' };
const VALID_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);

/**
 * Build a synthetic task_notification system message from a parsed XML payload,
 * shaped to match what Claude Code's emitTaskTerminatedSdk emits so the
 * existing DaemonBridge -> ClaudeChatWindow -> window.onTaskEvent path needs no
 * changes. The full <result> report is preferred over the one-line <summary>
 * as the event's summary so the frontend resultText shows the actual report.
 *
 * Returns null when the parsed status is not a terminal value the frontend
 * accepts, so a non-terminal or malformed envelope is ignored rather than
 * producing an event that parseTaskNotification would reject downstream.
 */
export function buildTaskNotificationEvent(parsed) {
  if (!parsed) return null;
  const status = STATUS_ALIASES[parsed.status] || parsed.status;
  if (!VALID_TERMINAL_STATUSES.has(status)) return null;
  const report = parsed.result || parsed.summary;
  return {
    type: 'system',
    subtype: 'task_notification',
    ...(parsed.taskId && { task_id: parsed.taskId }),
    tool_use_id: parsed.toolUseId,
    status,
    output_file: parsed.outputFile ?? '',
    ...(report !== undefined && { summary: report }),
  };
}
