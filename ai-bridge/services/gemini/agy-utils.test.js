import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgyArgs,
  mapPermissionMode,
  normalizeUsageToSnakeCase,
  extractAgyContextTokens,
  buildGeminiContextUsagePayload,
  buildErrorPayload,
  buildAgyEnv,
  resolveAgyBinary,
  parseAgyModelLine,
  parseAgyModelsOutput,
  splitAgyModelId,
  composeAgyModelId,
  resolveAgySpawnModel,
  groupAgyModelFamilies,
  stripEffortFromLabel,
} from './agy-utils.js';

test('resolveAgyBinary honors explicit AGY_PATH without fallback', () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  process.env.AGY_PATH = '/nonexistent/agy-binary-xyz';
  process.env.GEMINI_CLI_PATH = '';
  process.env.AGY_CLI_PATH = '';
  try {
    assert.equal(resolveAgyBinary(), null);
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
  }
});

test('resolveAgyBinary never returns agy.real even if AGY_PATH points at it', () => {
  const prev = process.env.AGY_PATH;
  const prevG = process.env.GEMINI_CLI_PATH;
  const prevA = process.env.AGY_CLI_PATH;
  process.env.AGY_PATH = '/Users/nobody/.local/bin/agy.real';
  process.env.GEMINI_CLI_PATH = '';
  process.env.AGY_CLI_PATH = '';
  try {
    const resolved = resolveAgyBinary();
    if (resolved) {
      assert.ok(!/agy\.real$/i.test(resolved), `must not resolve agy.real, got ${resolved}`);
    }
  } finally {
    if (prev === undefined) delete process.env.AGY_PATH;
    else process.env.AGY_PATH = prev;
    if (prevG === undefined) delete process.env.GEMINI_CLI_PATH;
    else process.env.GEMINI_CLI_PATH = prevG;
    if (prevA === undefined) delete process.env.AGY_CLI_PATH;
    else process.env.AGY_CLI_PATH = prevA;
  }
});

test('mapPermissionMode default does not skip permissions', () => {
  const m = mapPermissionMode('default');
  assert.equal(m.skipPermissions, false);
  assert.equal(m.modeFlag, '');
  assert.equal(m.sandbox, false);
});

test('mapPermissionMode bypass/yolo/dontAsk/auto skips permissions', () => {
  assert.equal(mapPermissionMode('bypassPermissions').skipPermissions, true);
  assert.equal(mapPermissionMode('bypass').skipPermissions, true);
  assert.equal(mapPermissionMode('yolo').skipPermissions, true);
  assert.equal(mapPermissionMode('dontAsk').skipPermissions, true);
  assert.equal(mapPermissionMode('dont_ask').skipPermissions, true);
  assert.equal(mapPermissionMode('auto').skipPermissions, true);
  assert.equal(mapPermissionMode('always-proceed').skipPermissions, true);
});

test('mapPermissionMode plan and accept-edits set mode flags', () => {
  assert.equal(mapPermissionMode('plan').modeFlag, 'plan');
  assert.equal(mapPermissionMode('acceptEdits').modeFlag, 'accept-edits');
  assert.equal(mapPermissionMode('accept-edits').modeFlag, 'accept-edits');
  assert.equal(mapPermissionMode('accept_edits').modeFlag, 'accept-edits');
});

test('mapPermissionMode sandbox sets sandbox flag', () => {
  assert.equal(mapPermissionMode('sandbox').sandbox, true);
  assert.equal(mapPermissionMode('sandbox').skipPermissions, false);
});

test('buildAgyArgs includes stream-json and conversation resume', () => {
  const args = buildAgyArgs({
    message: 'hello',
    conversationId: 'cid-1',
    model: 'gemini-3.5-flash-medium',
    effort: 'high',
    permissionMode: 'bypassPermissions',
  });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('hello'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--conversation'));
  assert.ok(args.includes('cid-1'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('gemini-3.5-flash-medium'));
  assert.ok(args.includes('--effort'));
  assert.ok(args.includes('high'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--continue'));
});

test('buildAgyArgs uses --continue when no conversation id', () => {
  const args = buildAgyArgs({
    message: 'hi',
    continueRecent: true,
  });
  assert.ok(args.includes('--continue'));
  assert.ok(!args.includes('--conversation'));
});

test('buildAgyArgs plan mode and add-dir and agent and print-timeout', () => {
  const args = buildAgyArgs({
    message: 'x',
    permissionMode: 'plan',
    agent: 'explorer',
    printTimeout: '30s',
    addDirs: ['/tmp/a', '', '/tmp/b'],
  });
  assert.ok(args.includes('--mode'));
  assert.ok(args.includes('plan'));
  assert.ok(args.includes('--agent'));
  assert.ok(args.includes('explorer'));
  assert.ok(args.includes('--print-timeout'));
  assert.ok(args.includes('30s'));
  assert.ok(args.includes('--add-dir'));
  assert.ok(args.includes('/tmp/a'));
  assert.ok(args.includes('/tmp/b'));
});

test('buildAgyArgs effort is lowercased', () => {
  const args = buildAgyArgs({ message: 'm', effort: 'HIGH' });
  const i = args.indexOf('--effort');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'high');
});

test('normalizeUsageToSnakeCase maps fields and camelCase', () => {
  const u = normalizeUsageToSnakeCase({
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 2,
    cache_read_tokens: 3,
    total_tokens: 17,
  });
  assert.deepEqual(u, {
    input_tokens: 10,
    output_tokens: 5,
    thinking_tokens: 2,
    cache_read_tokens: 3,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 0,
    total_tokens: 17,
  });

  const camel = normalizeUsageToSnakeCase({
    inputTokens: 1,
    outputTokens: 2,
    thinkingTokens: 3,
  });
  assert.equal(camel.input_tokens, 1);
  assert.equal(camel.output_tokens, 2);
  assert.equal(camel.thinking_tokens, 3);
  assert.equal(camel.total_tokens, 6);
});

test('normalizeUsageToSnakeCase returns null for empty usage', () => {
  assert.equal(normalizeUsageToSnakeCase(null), null);
  assert.equal(normalizeUsageToSnakeCase({}), null);
  assert.equal(normalizeUsageToSnakeCase({ input_tokens: 0, output_tokens: 0 }), null);
});

test('extractAgyContextTokens uses input+cache not total/output', () => {
  assert.equal(extractAgyContextTokens({
    input_tokens: 27793,
    output_tokens: 18,
    total_tokens: 27811,
  }), 27793);
  assert.equal(extractAgyContextTokens({
    input_tokens: 100,
    cache_read_tokens: 50,
    cache_creation_input_tokens: 25,
    output_tokens: 999,
    total_tokens: 1174,
  }), 175);
  assert.equal(extractAgyContextTokens(null), 0);
});

test('resolveAgySpawnModel upgrades bare gemini family to effort slug', () => {
  assert.deepEqual(resolveAgySpawnModel('gemini-3.6-flash', ''), {
    model: 'gemini-3.6-flash-medium',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('gemini-3.6-flash', 'high'), {
    model: 'gemini-3.6-flash-high',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('gemini-3.6-flash-low', 'high'), {
    model: 'gemini-3.6-flash-low',
    effort: '',
  });
  // Bare Claude models must never get a fake -medium suffix or --effort
  assert.deepEqual(resolveAgySpawnModel('claude-sonnet-4-6', 'medium'), {
    model: 'claude-sonnet-4-6',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('claude-sonnet-4-6', ''), {
    model: 'claude-sonnet-4-6',
    effort: '',
  });
  assert.deepEqual(resolveAgySpawnModel('claude-opus-4-6', 'thinking'), {
    model: 'claude-opus-4-6-thinking',
    effort: '',
  });
});

test('buildGeminiContextUsagePayload percentage', () => {
  const p = buildGeminiContextUsagePayload({ usedTokens: 50, maxTokens: 200, model: 'm' });
  assert.equal(p.success, true);
  assert.equal(p.data.percentage, 25);
  assert.equal(p.data.model, 'm');
  assert.equal(p.data.source, 'gemini-bridge');
});

test('buildGeminiContextUsagePayload clamps percentage at 100', () => {
  const p = buildGeminiContextUsagePayload({ usedTokens: 9999, maxTokens: 100 });
  assert.equal(p.data.percentage, 100);
});

test('buildErrorPayload extracts message', () => {
  const p = buildErrorPayload(new Error('boom'), { code: 1 });
  assert.equal(p.success, false);
  assert.equal(p.error, 'boom');
  assert.equal(p.code, 1);
});

test('buildAgyEnv sets non-interactive defaults', () => {
  const env = buildAgyEnv({ PATH: '/bin', HOME: '/tmp' });
  assert.equal(env.CI, '1');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.TERM, 'dumb');
});

test('parseAgyModelLine reads id and label', () => {
  const p = parseAgyModelLine('gemini-3.6-flash-high     Gemini 3.6 Flash (High)');
  assert.deepEqual(p, { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' });
  assert.equal(parseAgyModelLine('Usage of agy'), null);
  assert.deepEqual(parseAgyModelLine('claude-sonnet-4-6'), {
    id: 'claude-sonnet-4-6',
    label: 'claude-sonnet-4-6',
  });
});

test('groupAgyModelFamilies nests effort under family base', () => {
  const sample = `
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
gemini-3.6-flash-medium   Gemini 3.6 Flash (Medium)
gemini-3.6-flash-low      Gemini 3.6 Flash (Low)
gemini-3.5-flash-high     Gemini 3.5 Flash (High)
gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)
gemini-3.5-flash-low      Gemini 3.5 Flash (Low)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
gemini-3.1-pro-low        Gemini 3.1 Pro (Low)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking  Claude Opus 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`.trim();
  const entries = parseAgyModelsOutput(sample);
  const families = groupAgyModelFamilies(entries);

  // Gemini 3.6 Flash
  const flash36 = families.find((f) => f.id === 'gemini-3.6-flash');
  assert.ok(flash36);
  assert.equal(flash36.label, 'Gemini 3.6 Flash');
  assert.deepEqual(flash36.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.equal(flash36.defaultEffort, 'medium');

  // Gemini 3.5 Flash
  const flash35 = families.find((f) => f.id === 'gemini-3.5-flash');
  assert.ok(flash35);
  assert.equal(flash35.label, 'Gemini 3.5 Flash');
  assert.deepEqual(flash35.efforts.map((e) => e.id), ['low', 'medium', 'high']);
  assert.equal(flash35.defaultEffort, 'medium');

  // Gemini 3.1 Pro
  const pro31 = families.find((f) => f.id === 'gemini-3.1-pro');
  assert.ok(pro31);
  assert.equal(pro31.label, 'Gemini 3.1 Pro');
  assert.deepEqual(pro31.efforts.map((e) => e.id), ['low', 'high']);
  assert.equal(pro31.defaultEffort, 'high'); // high since no medium

  // Claude Sonnet 4.6
  const sonnet = families.find((f) => f.id === 'claude-sonnet-4-6');
  assert.ok(sonnet);
  assert.equal(sonnet.label, 'Claude Sonnet 4.6');
  assert.equal(sonnet.efforts.length, 1);
  assert.equal(sonnet.efforts[0].id, '');
  assert.equal(sonnet.efforts[0].modelId, 'claude-sonnet-4-6');
  assert.equal(sonnet.defaultEffort, '');

  // Claude Opus 4.6
  const opus = families.find((f) => f.id === 'claude-opus-4-6');
  assert.ok(opus);
  assert.equal(opus.label, 'Claude Opus 4.6');
  assert.deepEqual(opus.efforts.map((e) => e.id), ['thinking']);
  assert.equal(opus.defaultEffort, 'thinking');

  // GPT-OSS 120B
  const gpt = families.find((f) => f.id === 'gpt-oss-120b');
  assert.ok(gpt);
  assert.equal(gpt.label, 'GPT-OSS 120B');
  assert.deepEqual(gpt.efforts.map((e) => e.id), ['medium']);
  assert.equal(gpt.defaultEffort, 'medium');
});

test('split/compose agy model ids', () => {
  assert.deepEqual(splitAgyModelId('gemini-3.5-flash-high'), {
    baseId: 'gemini-3.5-flash',
    effort: 'high',
  });
  assert.equal(composeAgyModelId('gemini-3.5-flash', 'low'), 'gemini-3.5-flash-low');
  assert.equal(stripEffortFromLabel('Gemini 3.6 Flash (High)'), 'Gemini 3.6 Flash');
});
