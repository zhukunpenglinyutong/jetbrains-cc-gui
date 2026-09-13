// Child process for the "rewind candidates exclude interruption markers"
// scenario driven by message-rewind.test.mjs.
//
// Why a separate process: importing message-rewind.js pulls in api-config.js,
// which calls getRealHomeDir() at module load and caches the real home inside
// path-utils. Setting HOME afterwards has no effect, so the transcript must be
// resolved under a temp home BEFORE any module that touches getRealHomeDir is
// imported. The parent spawns this script with HOME pointed at a temp dir it
// owns and cleans up; this child must NOT create its own temp home or it
// leaks (the parent only rmSync's the dir it created).
//
// On success prints SCENARIO_OK and exits 0; any assertion failure rejects the
// top-level await, so Node exits non-zero and the parent surfaces it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const tempHome = process.env.HOME;
assert.ok(tempHome, 'parent must inject HOME');

const { resolveRewindCandidateMessageIds } = await import('./message-rewind.js');
const { getClaudeProjectKey } = await import('../../utils/path-utils.js');

const sessionDir = path.join(tempHome, '.claude', 'projects', getClaudeProjectKey(tempHome));
fs.mkdirSync(sessionDir, { recursive: true });

function runCandidateResolution(rows) {
  const file = path.join(sessionDir, 'rewind-candidates.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return resolveRewindCandidateMessageIds('rewind-candidates', tempHome, null);
}

// A turn was aborted: the CLI persisted its synthetic marker user row after
// the user's real message. It must not become a rewind anchor.
const withMarker = await runCandidateResolution([
  { type: 'user', uuid: 'real-1', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'asst-1', message: { role: 'assistant', content: 'hi' } },
  { type: 'user', uuid: 'interrupted-1', message: { role: 'user', content: '[Request interrupted by user]' } },
]);
assert.ok(!withMarker.includes('interrupted-1'), 'marker row must not be a rewind anchor');
assert.ok(withMarker.includes('real-1'), 'the real user message must remain a candidate');

// Without a marker, the real last user message is still picked. (With no
// providedMessageId the candidates are exactly the last user text message —
// real-1 only enters via the provided-message ancestor chain.)
const noMarker = await runCandidateResolution([
  { type: 'user', uuid: 'real-1', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'asst-1', message: { role: 'assistant', content: 'hi' } },
  { type: 'user', uuid: 'real-2', message: { role: 'user', content: 'follow up' } },
]);
assert.ok(noMarker.includes('real-2'), 'last real user message must be a candidate');
assert.ok(!noMarker.includes('interrupted-1'));

// A marker followed by the real message must still resolve to the real one.
const markerThenReal = await runCandidateResolution([
  { type: 'user', uuid: 'interrupted-1', message: { role: 'user', content: '[Request interrupted by user]' } },
  { type: 'user', uuid: 'real-3', message: { role: 'user', content: 'after the interrupt' } },
]);
assert.ok(markerThenReal.includes('real-3'), 'message after the marker must be picked');
assert.ok(!markerThenReal.includes('interrupted-1'));

// Rewind forks the transcript in place: rewound user rows stay on disk but
// the live branch parented past them. Their ids must not become anchors.
const rewoundFork = await runCandidateResolution([
  { type: 'user', uuid: 'root-1', parentUuid: null, timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', uuid: 'root-1-answer', parentUuid: 'root-1', timestamp: '2026-01-01T10:00:05Z', message: { id: 'm1', role: 'assistant', content: 'hi' } },
  { type: 'user', uuid: 'rewound-1', parentUuid: 'root-1-answer', timestamp: '2026-01-01T10:01:00Z', message: { role: 'user', content: 'rewound question' } },
  { type: 'assistant', uuid: 'rewound-1-answer', parentUuid: 'rewound-1', timestamp: '2026-01-01T10:01:05Z', message: { id: 'm2', role: 'assistant', content: 'rewound answer' } },
  { type: 'user', uuid: 'live-1', parentUuid: 'root-1-answer', timestamp: '2026-01-01T10:02:00Z', message: { role: 'user', content: 'retry question' } },
]);
assert.ok(rewoundFork.includes('live-1'), 'the live branch user message must be a candidate');
assert.ok(!rewoundFork.includes('rewound-1'), 'a rewound user row must not be a rewind anchor');

console.log('SCENARIO_OK');
