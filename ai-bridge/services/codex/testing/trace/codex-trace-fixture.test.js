import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  childServerRequests,
  interactionDeliveries,
  notificationsFor,
  notifyPrecedesAck,
  parseTrace,
  secretMarks,
  terminalEvents,
  userMessageEvents,
} from './codex-trace-format.js';

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'appserver-trace-v1.ndjson'
);

function loadFixture() {
  return parseTrace(readFileSync(fixturePath, 'utf8'));
}

test('shared trace fixture parses at the Node layer with version 1', () => {
  const { header, events } = loadFixture();
  assert.equal(header.traceVersion, 1);
  assert.ok(events.length > 10);
});

test('delayed id: item notifications precede the turn/start ack', () => {
  const { events } = loadFixture();
  assert.equal(
    notifyPrecedesAck(events, 'item/started', 7),
    true,
    'notify must be recorded before the ack of client request 7'
  );
});

test('child request carries parentThreadId and distinct thread identity', () => {
  const { events } = loadFixture();
  const childRequests = childServerRequests(events);
  assert.equal(childRequests.length, 1);
  assert.equal(childRequests[0].threadId, 'th-child-0002');
  assert.equal(childRequests[0].parentThreadId, 'th-root-0001');
  // The child request also exercises a string server id.
  assert.equal(childRequests[0].id, 'server-str-0009');
});

test('userMessage notifications keep distinct clientMessageIds', () => {
  const { events } = loadFixture();
  const userMessages = userMessageEvents(events);
  assert.ok(userMessages.length >= 2, 'fixture records two user messages');
  const ids = new Set(userMessages.map((event) => event.clientMessageId));
  assert.equal(ids.size, userMessages.length, 'clientMessageIds never collide');
  for (const event of userMessages) {
    assert.ok(event.clientMessageId.length > 0);
  }
});

test('show/close deliveries use a monotonic sequence and honor tombstones', () => {
  const { events } = loadFixture();
  const byKey = interactionDeliveries(events);
  const deliveries = byKey.get('gen1:ch1:ep1:req3');
  assert.ok(deliveries, 'fixture records deliveries for the interaction key');
  const sequences = deliveries.map((event) => event.deliverySequence);
  for (let i = 1; i < sequences.length; i += 1) {
    assert.ok(sequences[i] > sequences[i - 1], 'deliverySequence is strictly increasing');
  }
  // Sequence 3 is a late show replaying after the request resolved; the
  // tombstone flag must be present so consumers reject it.
  const lateShow = deliveries.find(
    (event) => event.kind === 'interaction_show' && event.deliverySequence === 3
  );
  assert.ok(lateShow, 'late show is recorded');
  assert.equal(lateShow.resolvedTombstone, true);
});

test('mixed secret marks separate the secret question from the normal one', () => {
  const { events } = loadFixture();
  const marks = secretMarks(events);
  assert.equal(marks.get('q-0001'), false, 'normal question stays visible');
  assert.equal(marks.get('q-0002'), true, 'secret question is flagged');
  // The trace never carries answer text; only typed decision labels.
  const raw = JSON.stringify(events);
  assert.ok(!raw.includes('normal-answer-visible'.toUpperCase()));
});

test('terminal count is checkable across root and child threads', () => {
  const { events } = loadFixture();
  const terminals = terminalEvents(events);
  assert.equal(terminals.length, 2);
  const rootTerminals = notificationsFor(events, 'th-root-0001').filter(
    (event) => event.method === 'turn/completed'
  );
  const childTerminals = notificationsFor(events, 'th-child-0002').filter(
    (event) => event.method === 'turn/completed'
  );
  assert.equal(rootTerminals.length, 1);
  assert.equal(childTerminals.length, 1);
  assert.equal(childTerminals[0].childTerminal, true);
});

test('workspace diff fixture records snapshot identity without content', () => {
  const { events } = loadFixture();
  const diffEvents = events.filter((event) => event.kind === 'workspace_diff');
  assert.equal(diffEvents.length, 1);
  const diff = diffEvents[0];
  assert.equal(diff.stagedCount, 1);
  assert.equal(diff.unstagedCount, 2);
  assert.equal(diff.untrackedCount, 1);
  assert.ok(diff.repoRoot.length > 0);
  assert.ok(!('patch' in diff), 'diff content is never embedded');
});

test('fixture contains no secret material', () => {
  const raw = readFileSync(fixturePath, 'utf8');
  for (const forbidden of ['sk-', 'api_key', 'apiKey', 'Bearer ', 'password']) {
    assert.ok(!raw.includes(forbidden), `fixture must not contain ${forbidden}`);
  }
});
