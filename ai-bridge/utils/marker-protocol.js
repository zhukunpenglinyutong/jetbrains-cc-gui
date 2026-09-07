/**
 * Shared bridge marker protocol used by CLI providers (Grok / Kimi / OpenCode).
 * Java MarkerCliBridge parses these lines into MessageCallback events.
 */

export function emitJsonStringMarker(tag, text) {
  process.stdout.write(`${tag} ${JSON.stringify(text)}\n`);
}

export function emitSendError(message, label = 'CLI') {
  console.log(`[SEND_ERROR] ${JSON.stringify({ error: String(message || `Unknown ${label} error`) })}`);
}

export function emitSessionId(sessionId) {
  if (sessionId) {
    console.log(`[SESSION_ID] ${sessionId}`);
  }
}

export function emitUsage(usage) {
  if (usage && typeof usage === 'object') {
    console.log(`[USAGE] ${JSON.stringify(usage)}`);
  }
}

export function emitMessageMarker(messageObject) {
  console.log(`[MESSAGE] ${JSON.stringify(messageObject)}`);
}

export function beginStream() {
  console.log('[MESSAGE_START]');
  console.log('[STREAM_START]');
}

export function endStream() {
  console.log('[STREAM_END]');
  console.log('[MESSAGE_END]');
}

/**
 * Emit Claude-compatible tool_use / tool_result MESSAGE markers.
 */
export function emitToolUseMessage({ id, name, input }) {
  emitMessageMarker({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: id || 'tool-1',
          name: name || 'tool',
          input: input && typeof input === 'object' ? input : {},
        },
      ],
    },
  });
}

export function emitToolResultMessage({ toolUseId, content, isError = false }) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  emitMessageMarker({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId || 'tool-1',
          is_error: Boolean(isError),
          content: text,
        },
      ],
    },
  });
}

// Leading "@" is guarded the same way as leading "-": pi/omp (parseArgs in
// cli/args.ts) classify ANY argv token starting with "@" as a file argument
// (fileArgs -> processFileArguments -> "Error: File not found" + exit 1).
// A leading space keeps the token in `messages` while the mention still
// parses (omp's mention regex allows whitespace before "@").
export function safePromptArg(text) {
  if (typeof text === 'string' && (text.startsWith('-') || text.startsWith('@'))) {
    return ` ${text}`;
  }
  return text ?? '';
}

export function isNonEmptySessionId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.' || trimmed.includes('..')) return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  return true;
}
