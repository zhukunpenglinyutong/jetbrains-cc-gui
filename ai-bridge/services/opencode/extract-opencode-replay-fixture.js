#!/usr/bin/env node
/**
 * Create an opencode replay fixture skeleton from captured event JSONL/logs.
 *
 * Usage:
 *   node ai-bridge/services/opencode/extract-opencode-replay-fixture.js events.jsonl \
 *     --session ses_123 --name my-regression > fixture.json
 *
 * The input may contain raw JSON events, SDK global events with `payload`, or
 * log lines where the first JSON object is the event payload.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

function parseArgs(argv) {
  const args = { file: '', sessionId: '', name: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--session') {
      args.sessionId = argv[++i] || '';
    } else if (arg === '--name') {
      args.name = argv[++i] || '';
    } else if (!arg.startsWith('--') && !args.file) {
      args.file = arg;
    }
  }
  return args;
}

function extractJson(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  if (firstBrace > 0) {
    candidates.push(trimmed.slice(firstBrace));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function normalizeEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const event = value.payload && typeof value.payload === 'object' ? value.payload : value;
  if (typeof event.type !== 'string' || !event.properties || typeof event.properties !== 'object') {
    return null;
  }
  if (event.type === 'server.connected' || event.type === 'server.heartbeat') {
    return null;
  }
  return event;
}

function eventSessionId(event) {
  const props = event?.properties || {};
  return props.sessionID || props.sessionId || props.part?.sessionID || props.session?.id || '';
}

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  console.error('Usage: extract-opencode-replay-fixture.js <events.log|jsonl> [--session ses_id] [--name fixture-name]');
  process.exit(2);
}

const raw = await readFile(args.file, 'utf8');
const events = raw
  .split(/\r?\n/)
  .map(extractJson)
  .map(normalizeEvent)
  .filter(Boolean)
  .filter((event) => !args.sessionId || eventSessionId(event) === args.sessionId);

const fixture = {
  name: args.name || basename(args.file).replace(/\.[^.]+$/, ''),
  cwd: '',
  sessionId: args.sessionId || eventSessionId(events[0]) || '',
  description: 'TODO: explain the rendering regression this fixture covers.',
  events,
  expect: {
    contentDeltas: [],
    thinkingDeltas: [],
    forbiddenContent: [],
    toolUseIds: [],
    toolResultIds: [],
    blockResetCount: 0,
    webviewReplay: []
  }
};

console.log(JSON.stringify(fixture, null, 2));
