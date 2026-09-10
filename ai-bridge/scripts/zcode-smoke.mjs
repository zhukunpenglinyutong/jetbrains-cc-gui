// Real end-to-end smoke test against the local ZCode app-server.
// Usage: node scripts/zcode-smoke.mjs
import {
  sendMessagePersistent,
  abortCurrentTurn,
  shutdownPersistentRuntimes,
} from '../services/zcode/persistent-zcode-service.js';

const markerLines = [];
const origLog = console.log.bind(console);
console.log = (...a) => { markerLines.push(a.join(' ')); };
console.error('[SMOKE] sending turn...');
const started = Date.now();

const sendPromise = sendMessagePersistent({
  message: 'Reply with exactly the word PONG and nothing else.',
  cwd: process.cwd(),
  permissionMode: 'default',
  model: '',
  reasoningEffort: '',
});

// Auto-stop test: after 8s, if still running, abort (validates stop path).
const abortTimer = setTimeout(async () => {
  console.error('[SMOKE] 8s elapsed without completion — testing abort path');
  await abortCurrentTurn();
}, 8000);

const result = await sendPromise;
clearTimeout(abortTimer);
origLog('[SMOKE-RESULT]', JSON.stringify(result));
origLog(`[SMOKE] elapsed=${Date.now() - started}ms markers=${markerLines.length}`);
const kinds = {};
for (const l of markerLines) {
  const m = l.match(/^\[([A-Z_]+)\]/);
  const k = m ? m[1] : (l.startsWith('{') ? 'JSON' : 'OTHER');
  kinds[k] = (kinds[k] || 0) + 1;
}
origLog('[SMOKE] marker histogram:', JSON.stringify(kinds));
const deltas = markerLines.filter((l) => l.startsWith('[CONTENT_DELTA]'))
  .map((l) => JSON.parse(l.slice('[CONTENT_DELTA]'.length)));
origLog('[SMOKE] content:', JSON.stringify(deltas.join('')));
await shutdownPersistentRuntimes();
process.exit(0);
