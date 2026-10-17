/**
 * Webview-layer parse of the shared sanitized trace fixture (task 1.6 of the
 * migrate-codex-to-app-server change).
 *
 * The same NDJSON fixture is parsed by the Node layer
 * (ai-bridge/services/codex/testing/trace/codex-trace-fixture.test.js) and the
 * Java layer (CodexTraceFixtureTest). Keeping one file proves all three layers
 * agree on the versioned trace contract. The fixture carries identities and
 * flags only — never secret answer text or credentials.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TRACE_VERSION = 1;

interface TraceEvent {
  traceVersion: number;
  kind: string;
  method?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  clientMessageId?: string;
  itemType?: string;
  parentThreadId?: string | null;
  id?: unknown;
  ackForClientRequestId?: number;
  deliverySequence?: number;
  resolvedTombstone?: boolean;
  isSecret?: boolean;
  questionId?: string;
  stagedCount?: number;
  unstagedCount?: number;
  untrackedCount?: number;
  patch?: unknown;
}

interface ParsedTrace {
  header: { traceVersion: number };
  events: TraceEvent[];
}

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../ai-bridge/services/codex/testing/trace/fixtures/appserver-trace-v1.ndjson',
);

function loadFixture(): ParsedTrace {
  const lines = readFileSync(fixturePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const header = JSON.parse(lines[0]) as { traceVersion: number };
  expect(header.traceVersion).toBe(TRACE_VERSION);
  const events = lines.slice(1).map((line) => JSON.parse(line) as TraceEvent);
  return { header, events };
}

describe('shared codex trace fixture (webview layer)', () => {
  it('parses version 1 with a meaningful event stream', () => {
    const { header, events } = loadFixture();
    expect(header.traceVersion).toBe(1);
    expect(events.length).toBeGreaterThan(10);
  });

  it('delayed id: item notifications precede the turn/start ack', () => {
    const { events } = loadFixture();
    const notifyIndex = events.findIndex(
      (event) => event.kind === 'notify' && event.method === 'item/started',
    );
    const ackIndex = events.findIndex(
      (event) => event.kind === 'response' && event.ackForClientRequestId === 7,
    );
    expect(notifyIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(notifyIndex);
  });

  it('child request carries parentThreadId and a string server id', () => {
    const { events } = loadFixture();
    const childRequests = events.filter(
      (event) => event.kind === 'server_request' && Boolean(event.parentThreadId),
    );
    expect(childRequests).toHaveLength(1);
    expect(childRequests[0].threadId).toBe('th-child-0002');
    expect(childRequests[0].parentThreadId).toBe('th-root-0001');
    expect(childRequests[0].id).toBe('server-str-0009');
  });

  it('userMessage notifications keep distinct clientMessageIds', () => {
    const { events } = loadFixture();
    const userMessages = events.filter(
      (event) => event.kind === 'notify' && event.itemType === 'userMessage',
    );
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(userMessages.map((event) => event.clientMessageId));
    expect(ids.size).toBe(userMessages.length);
  });

  it('show/close deliveries use a monotonic sequence and honor tombstones', () => {
    const { events } = loadFixture();
    const deliveries = events
      .filter(
        (event) =>
          event.kind === 'interaction_show' || event.kind === 'interaction_close',
      )
      .sort((a, b) => (a.deliverySequence ?? 0) - (b.deliverySequence ?? 0));
    expect(deliveries.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < deliveries.length; i += 1) {
      expect(deliveries[i].deliverySequence).toBeGreaterThan(
        deliveries[i - 1].deliverySequence ?? 0,
      );
    }
    const lateShow = deliveries.find(
      (event) => event.kind === 'interaction_show' && event.deliverySequence === 3,
    );
    expect(lateShow?.resolvedTombstone).toBe(true);
  });

  it('mixed secret marks separate the secret question from the normal one', () => {
    const { events } = loadFixture();
    const marks = new Map<string, boolean>();
    for (const event of events) {
      if (event.kind === 'secret_marked' && event.questionId) {
        marks.set(event.questionId, event.isSecret === true);
      }
    }
    expect(marks.get('q-0001')).toBe(false);
    expect(marks.get('q-0002')).toBe(true);
  });

  it('terminal count is checkable across root and child threads', () => {
    const { events } = loadFixture();
    const terminals = events.filter(
      (event) => event.kind === 'notify' && event.method === 'turn/completed',
    );
    expect(terminals).toHaveLength(2);
    expect(
      terminals.filter((event) => event.threadId === 'th-root-0001'),
    ).toHaveLength(1);
    expect(
      terminals.filter((event) => event.threadId === 'th-child-0002'),
    ).toHaveLength(1);
  });

  it('workspace diff fixture records snapshot counts without content', () => {
    const { events } = loadFixture();
    const diffEvents = events.filter((event) => event.kind === 'workspace_diff');
    expect(diffEvents).toHaveLength(1);
    expect(diffEvents[0].stagedCount).toBe(1);
    expect(diffEvents[0].unstagedCount).toBe(2);
    expect(diffEvents[0].untrackedCount).toBe(1);
    expect(diffEvents[0].patch).toBeUndefined();
  });

  it('fixture contains no secret material', () => {
    const raw = readFileSync(fixturePath, 'utf8');
    for (const forbidden of ['sk-', 'api_key', 'apiKey', 'Bearer ', 'password']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
