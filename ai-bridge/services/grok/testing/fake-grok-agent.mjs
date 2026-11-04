#!/usr/bin/env node
/**
 * Minimal `grok agent stdio` stand-in for daemon-level tests (GROK_CLI_PATH).
 *
 * FAKE_GROK_TURN_MS  how long session/prompt streams before it ends (default 1500)
 * FAKE_GROK_BILLING  'hang' never answers _x.ai/billing; otherwise a 42% weekly window
 * FAKE_GROK_LOG      file that receives one line per request method
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const turnMs = Number(process.env.FAKE_GROK_TURN_MS) || 1500;
const logFile = process.env.FAKE_GROK_LOG || '';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const log = (method) => {
  if (logFile) appendFileSync(logFile, `${method}\n`);
};

function streamTurn(id, sessionId) {
  let n = 0;
  const tick = setInterval(() => {
    send({
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `chunk${n++} ` } } },
    });
  }, 200);
  setTimeout(() => {
    clearInterval(tick);
    send({ id, result: { stopReason: 'end_turn' } });
  }, turnMs);
}

const rl = createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id == null || !msg.method) return;
  log(msg.method);
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: 'cached_token' }, { id: 'xai.api_key' }], agentCapabilities: { loadSession: false } } });
      return;
    case 'session/new':
      send({ id: msg.id, result: { sessionId: `sess-${process.pid}` } });
      return;
    case '_x.ai/billing':
      if (process.env.FAKE_GROK_BILLING === 'hang') return;
      send({
        id: msg.id,
        result: {
          subscriptionTier: 'SuperGrok',
          config: { creditUsagePercent: 42, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-26T00:00:00Z', end: '2026-11-02T00:00:00Z' } },
        },
      });
      return;
    case 'session/prompt': {
      const text = msg.params?.prompt?.[0]?.text || '';
      // Permission-mode sync ("/always-approve off") is a control prompt, not a user turn.
      if (text.startsWith('/always-approve')) {
        send({ id: msg.id, result: { stopReason: 'end_turn' } });
        return;
      }
      streamTurn(msg.id, msg.params?.sessionId);
      return;
    }
    default:
      send({ id: msg.id, result: {} });
  }
});
