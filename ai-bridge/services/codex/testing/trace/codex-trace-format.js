/**
 * Shared versioned sanitized trace parser (traceVersion 1).
 *
 * The same NDJSON trace is produced by the stdio test peer
 * (services/codex/testing/codex-stdio-peer.js), consumed by Java integration
 * tests (CodexAppServerIntegrationTest) and webview Vitest fixtures
 * (webview/src/utils/codexTraceFixture.test.ts). The canonical fixture is
 * trace/fixtures/appserver-trace-v1.ndjson.
 *
 * Sanitization contract: trace events carry identities (ids, methods,
 * directions, sequence numbers, secret FLAGS) but never secret answer text,
 * credentials, or user content. The fixture answer strings are placeholders
 * ("normal-answer-visible", "REDACTED_SECRET") rather than real data.
 */

export const TRACE_VERSION = 1;

export const TRACE_KINDS = Object.freeze([
  'client_message',
  'notify',
  'response',
  'response_error',
  'server_request',
  'server_response',
  'interaction_show',
  'interaction_close',
  'secret_marked',
  'workspace_diff',
  'peer_raw',
  'stderr',
  'initialized',
  'unparseable_client_line',
  'exit',
]);

/**
 * Parse an NDJSON trace into {header, events}.
 * The first line must carry the matching traceVersion.
 */
export function parseTrace(ndjson) {
  const lines = String(ndjson).split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error('trace is empty');
  }
  const header = JSON.parse(lines[0]);
  if (header.traceVersion !== TRACE_VERSION) {
    throw new Error(`unsupported traceVersion: ${header.traceVersion}`);
  }
  const events = lines.slice(1).map((line, index) => {
    const event = JSON.parse(line);
    if (event.traceVersion !== TRACE_VERSION) {
      throw new Error(`event ${index} has unsupported traceVersion: ${event.traceVersion}`);
    }
    return event;
  });
  return { header, events };
}

/** Notifications that end a native turn. */
export function terminalEvents(events) {
  return events.filter((event) => event.kind === 'notify' && event.method === 'turn/completed');
}

/** Notifications for one thread id. */
export function notificationsFor(events, threadId) {
  return events.filter((event) => event.kind === 'notify' && event.threadId === threadId);
}

/**
 * True when a notification for the given relation arrives before the ack of
 * the client request (the "notify before ack" fixture requirement).
 */
export function notifyPrecedesAck(events, method, clientRequestId) {
  const notifyIndex = events.findIndex(
    (event) => event.kind === 'notify' && event.method === method
  );
  const ackIndex = events.findIndex(
    (event) => event.kind === 'response' && event.ackForClientRequestId === clientRequestId
  );
  return notifyIndex >= 0 && ackIndex >= 0 && notifyIndex < ackIndex;
}

/** Server requests whose thread belongs to a child (has parentThreadId). */
export function childServerRequests(events) {
  return events.filter(
    (event) => event.kind === 'server_request' && event.parentThreadId
  );
}

/** User-message notifications carrying a clientMessageId. */
export function userMessageEvents(events) {
  return events.filter(
    (event) => event.kind === 'notify' && event.itemType === 'userMessage'
  );
}

/**
 * Show/close interaction deliveries, keyed by interactionKey, sorted by
 * deliverySequence. A resolved tombstone must not be followed by a live show.
 */
export function interactionDeliveries(events) {
  const deliveries = events.filter(
    (event) => event.kind === 'interaction_show' || event.kind === 'interaction_close'
  );
  const byKey = new Map();
  for (const event of deliveries) {
    if (!byKey.has(event.interactionKey)) {
      byKey.set(event.interactionKey, []);
    }
    byKey.get(event.interactionKey).push(event);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => a.deliverySequence - b.deliverySequence);
  }
  return byKey;
}

/** Secret classification marks recorded for question ids. */
export function secretMarks(events) {
  const marks = new Map();
  for (const event of events) {
    if (event.kind === 'secret_marked') {
      marks.set(event.questionId, event.isSecret === true);
    }
  }
  return marks;
}
