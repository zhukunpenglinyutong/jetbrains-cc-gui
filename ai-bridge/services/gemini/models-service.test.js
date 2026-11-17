/**
 * Tests for the Gemini (agy) models service.
 *
 * The expected catalog shape is pinned by the LIVE-captured fixture
 * fixtures/models-catalog.tsv (`agy models` stdout, captured 2026-09-03):
 * one `id<TAB>Human Label` pair per line, no preamble on stdout — the
 * "Fetching available models..." spinner goes to stderr.
 *
 * The CLI is a generated fake (same approach as message-service.test.js)
 * so no real `agy` is needed; a delay-based fake pins the timeout path.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const SERVICE_DIR = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = join(SERVICE_DIR, 'fixtures');

const LIVE_CATALOG = readFileSync(join(FIXTURES_DIR, 'models-catalog.tsv'), 'utf8');

const FAKE_CATALOG_CLI_BODY = `
import { appendFileSync, readFileSync } from 'node:fs';
// The argv log pins the exact subcommand the service probes with — spawnSync
// stderr is not forwarded anywhere a test could read it.
if (process.env.FAKE_ARGV_FILE) {
  appendFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)) + '\\n');
}
process.stdout.write(readFileSync(process.env.FAKE_CATALOG_FILE, 'utf8'));
process.exit(0);
`;

const FAKE_SLEEP_CLI_BODY = `
import { setTimeout as delay } from 'node:timers/promises';
await delay(Number(process.env.FAKE_SLEEP_SECONDS || '5') * 1000);
process.exit(0);
`;

const FAKE_FAIL_CLI_BODY = `
process.stderr.write('catalog unavailable');
process.exit(3);
`;

const FAKE_EMPTY_CLI_BODY = `
process.exit(0);
`;

/** Cross-platform launcher: spawnable on POSIX (shebang) and Windows (.cmd). */
function writeFakeCli(dir, name, body) {
  const bodyPath = join(dir, `${name}.mjs`);
  writeFileSync(bodyPath, body, 'utf8');
  if (process.platform === 'win32') {
    const cmd = join(dir, `${name}.cmd`);
    writeFileSync(cmd, `@echo off\r\nnode "${bodyPath}" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = join(dir, name);
  writeFileSync(sh, `#!/bin/sh\nexec node "${bodyPath}" "$@"\n`, 'utf8');
  chmodSync(sh, 0o755);
  return sh;
}

const TMP_DIR = mkdtempSync(join(tmpdir(), 'gemini-models-test-'));
const CATALOG_COPY = join(TMP_DIR, 'catalog.tsv');
writeFileSync(CATALOG_COPY, LIVE_CATALOG, 'utf8');
// The catalog fake reads its TSV through this env var; node:test runs each
// file in its own process, so no cleanup is needed.
process.env.FAKE_CATALOG_FILE = CATALOG_COPY;
process.env.FAKE_ARGV_FILE = join(TMP_DIR, 'argv.log');
const FAKE_CATALOG_CLI = writeFakeCli(TMP_DIR, 'fake-agy-models', FAKE_CATALOG_CLI_BODY);
const FAKE_SLEEP_CLI = writeFakeCli(TMP_DIR, 'fake-agy-sleep', FAKE_SLEEP_CLI_BODY);
const FAKE_FAIL_CLI = writeFakeCli(TMP_DIR, 'fake-agy-fail', FAKE_FAIL_CLI_BODY);
const FAKE_EMPTY_CLI = writeFakeCli(TMP_DIR, 'fake-agy-empty', FAKE_EMPTY_CLI_BODY);
after(() => {
  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function withGeminiBin(bin, fn) {
  const previous = process.env.GEMINI_BIN;
  process.env.GEMINI_BIN = bin;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.GEMINI_BIN;
    } else {
      process.env.GEMINI_BIN = previous;
    }
  }
}

const { parseAgyModelsOutput, listModels } = await import('./models-service.js');

test('parseAgyModelsOutput reads the live catalog: full slugs and human labels', () => {
  const models = parseAgyModelsOutput(LIVE_CATALOG);

  // Every live line survives: ids are the FULL slugs exactly as printed (the
  // tier is baked into the slug), labels stay verbatim.
  assert.deepEqual(
    models.map((m) => `${m.id}\t${m.label}`),
    LIVE_CATALOG.trim().split('\n'),
  );
  // The label-driven tier exemplars stay intact.
  assert.ok(models.some((m) => m.id === 'gemini-3.1-pro-high' && m.label === 'Gemini 3.1 Pro (High)'));
  assert.ok(models.some((m) => m.id === 'claude-sonnet-4-6' && m.label === 'Claude Sonnet 4.6 (Thinking)'));
  assert.ok(models.some((m) => m.id === 'gpt-oss-120b-medium' && m.label === 'GPT-OSS 120B (Medium)'));
});

test('parseAgyModelsOutput skips preamble, blank and tab-less garbage lines', () => {
  const noisy = [
    'Fetching available models...', // preamble if a future CLI moves it to stdout
    '',
    '   ',
    'gemini-x-flash-high\tGemini X Flash (High)',
    'no tabs in this line',
    '######',
    '\torphan id-less row',
    'gemini-x-flash-high\tduplicate id',
    'gemini-y-pro-low\tY Pro (Low)\textra\tcolumns',
  ].join('\n');
  const models = parseAgyModelsOutput(noisy);
  assert.deepEqual(models, [
    { id: 'gemini-x-flash-high', label: 'Gemini X Flash (High)' },
    { id: 'gemini-y-pro-low', label: 'Y Pro (Low) extra columns' },
  ]);
});

test('parseAgyModelsOutput handles CRLF output and non-string input', () => {
  assert.deepEqual(parseAgyModelsOutput('a-b-high\tA B (High)\r\na-b-low\tA B (Low)\r\n'), [
    { id: 'a-b-high', label: 'A B (High)' },
    { id: 'a-b-low', label: 'A B (Low)' },
  ]);
  assert.deepEqual(parseAgyModelsOutput(''), []);
  assert.deepEqual(parseAgyModelsOutput(null), []);
  assert.deepEqual(parseAgyModelsOutput(undefined), []);
});

const AUTO_ENTRY = { id: 'auto', label: 'Default (CLI)', description: 'Use the Antigravity CLI default model' };

test('listModels answers the catalog payload with the auto sentinel first', () => {
  const payload = withGeminiBin(FAKE_CATALOG_CLI, () => listModels());

  assert.equal(payload.success, true);
  assert.equal(payload.provider, 'gemini');
  assert.equal(payload.defaultModel, 'auto');
  assert.equal(payload.models[0].id, 'auto');
  assert.equal(payload.models.length, LIVE_CATALOG.trim().split('\n').length + 1);
  // Catalog ids follow verbatim after the sentinel, in CLI order.
  assert.equal(payload.models[1].id, 'gemini-3.8-flash-high');
  assert.equal(payload.models.at(-1).id, 'gpt-oss-120b-medium');
});

test('listModels probes the CLI with the `models` subcommand', () => {
  writeFileSync(process.env.FAKE_ARGV_FILE, '');
  withGeminiBin(FAKE_CATALOG_CLI, () => listModels());

  const argvLines = readFileSync(process.env.FAKE_ARGV_FILE, 'utf8').split('\n').filter(Boolean);
  assert.ok(argvLines.length > 0, 'the fake CLI must have logged its argv');
  for (const line of argvLines) {
    const argv = JSON.parse(line);
    assert.ok(argv.includes('models'), `expected the models subcommand, got: ${line}`);
  }
});

test('listModels drops catalog lines the picker could never send', () => {
  // Sentinel clones would render a second "Default (CLI)" row, and ids the
  // send path silently collapses (sentinels, dash-led tokens) must not be
  // offered at all. parseAgyModelsOutput keeps them; the payload pins the
  // picker to sendable ids.
  const noisyPath = join(TMP_DIR, 'noisy-catalog.tsv');
  writeFileSync(noisyPath, [
    'auto\tDuplicate Default (CLI)',
    'default\tAnother sentinel',
    '-weird\tDash-led id',
    'gemini-x-flash-high\tGemini X Flash (High)',
  ].join('\n'), 'utf8');
  const previous = process.env.FAKE_CATALOG_FILE;
  process.env.FAKE_CATALOG_FILE = noisyPath;
  try {
    const payload = withGeminiBin(FAKE_CATALOG_CLI, () => listModels());
    assert.equal(payload.success, true);
    assert.deepEqual(payload.models, [
      AUTO_ENTRY,
      { id: 'gemini-x-flash-high', label: 'Gemini X Flash (High)' },
    ]);
  } finally {
    process.env.FAKE_CATALOG_FILE = previous;
  }
});

test('listModels prints the payload JSON on stdout for the channel protocol', () => {
  const printed = [];
  const originalLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    withGeminiBin(FAKE_CATALOG_CLI, () => listModels());
  } finally {
    console.log = originalLog;
  }
  assert.equal(printed.length, 1, 'exactly one JSON line for the Java reader');
  const payload = JSON.parse(printed[0]);
  assert.equal(payload.success, true);
  assert.equal(payload.provider, 'gemini');
  assert.equal(payload.defaultModel, 'auto');
  assert.deepEqual(payload.models[0], AUTO_ENTRY);
});

test('listModels fails honestly when the CLI is absent — no fabricated catalog', () => {
  const payload = withGeminiBin(join(TMP_DIR, 'no-such-agy'), () => listModels());
  assert.equal(payload.success, false);
  assert.equal(payload.provider, 'gemini');
  assert.equal(payload.defaultModel, 'auto');
  assert.deepEqual(payload.models, []);
  assert.match(payload.error, /agy/i);
});

test('listModels fails honestly when the CLI exceeds the probe timeout', () => {
  const payload = withGeminiBin(FAKE_SLEEP_CLI, () => listModels({ timeoutMs: 300 }));
  assert.equal(payload.success, false);
  assert.deepEqual(payload.models, []);
  assert.match(payload.error, /timed out|timeout/i);
});

test('listModels fails honestly on a nonzero CLI exit', () => {
  const payload = withGeminiBin(FAKE_FAIL_CLI, () => listModels());
  assert.equal(payload.success, false);
  assert.deepEqual(payload.models, []);
  assert.match(payload.error, /catalog unavailable|exited with code 3/i);
});

test('listModels succeeds with only the auto entry when the catalog is empty', () => {
  const payload = withGeminiBin(FAKE_EMPTY_CLI, () => listModels());
  assert.equal(payload.success, true);
  assert.deepEqual(payload.models, [AUTO_ENTRY]);
});
