import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const handlerFile = path.join(repoRoot, 'src/main/java/com/github/claudecodegui/handler/TokenTrackerHandler.java');
const apiFile = path.join(repoRoot, 'webview/src/components/UsageStatistics/tokentracker-dashboard/lib/api.ts');

const enabled = process.env.TOKENTRACKER_CONTRACT === '1';
const DAY_MS = 86_400_000;

const pinnedPackage = async () => {
  if (process.env.TOKENTRACKER_PACKAGE) return process.env.TOKENTRACKER_PACKAGE;
  const source = await readFile(handlerFile, 'utf8');
  const match = /TT_CLI_PACKAGE\s*=\s*"(tokentracker-cli@[^"]+)"/.exec(source);
  assert.ok(match, 'TT_CLI_PACKAGE not found in TokenTrackerHandler.java');
  return match[1];
};

const dashboardSlugs = async () => {
  const source = await readFile(apiFile, 'utf8');
  const block = /const PATHS = \{([^}]*)\}/.exec(source);
  assert.ok(block, 'PATHS not found in api.ts');
  const slugs = [...block[1].matchAll(/:\s*"(tokentracker-[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(slugs.length > 0, 'no endpoints found in api.ts PATHS');
  return slugs;
};

const HOST_ENV_KEYS = ['PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec'];

const isolatedEnv = (home, tmp) => ({
  ...Object.fromEntries(HOST_ENV_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
  TOKENTRACKER_NO_TELEMETRY: '1',
  TOKENTRACKER_PROXY_ENV_APPLIED: '1',
});

const SUMMARY_TOTAL_FIELDS = [
  'total_tokens', 'billable_total_tokens', 'total_cost_usd',
  'input_tokens', 'cached_input_tokens', 'cache_creation_input_tokens',
];

const yesterday = () => new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);

const USAGE = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000 };
const TOKENS_PER_ENTRY = Object.values(USAGE).reduce((a, b) => a + b, 0);

const writeClaudeSessions = async (claudeDir, project, tag, model, entries) => {
  const dir = path.join(claudeDir, 'projects', project);
  await mkdir(dir, { recursive: true });
  const startOfToday = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const lines = Array.from({ length: entries }, (_, i) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(startOfToday - 12 * 3_600_000 - i * 3_600_000).toISOString(),
    sessionId: `${tag}-session`,
    cwd: `/work/${project}`,
    uuid: `${tag}-uuid-${i}`,
    requestId: `${tag}-req-${i}`,
    message: { id: `${tag}-msg-${i}`, role: 'assistant', model, usage: USAGE },
  }));
  await writeFile(path.join(dir, `${tag}.jsonl`), `${lines.join('\n')}\n`);
  return entries * TOKENS_PER_ENTRY;
};

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const eventually = async (fn, { timeout = 30_000, interval = 500 } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
};

describe('pinned tokentracker-cli contract', { skip: enabled ? false : 'set TOKENTRACKER_CONTRACT=1 (npm run test:tokentracker)' }, () => {
  let workDir;
  let home;
  let base;
  let server;
  let primaryTokens;

  const range = () => {
    const today = new Date();
    return {
      from: new Date(today.getTime() - 10 * DAY_MS).toISOString().slice(0, 10),
      to: today.toISOString().slice(0, 10),
      tz: 'UTC',
      tz_offset_minutes: '0',
    };
  };
  const getJson = async (slug, params = range()) => {
    const response = await fetch(`${base}/functions/${slug}?${new URLSearchParams(params)}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const triggerSync = async () => {
    const { token } = await (await fetch(`${base}/api/local-auth`)).json();
    return fetch(`${base}/functions/tokentracker-local-sync`, {
      method: 'POST',
      headers: { 'x-tokentracker-local-auth': token, 'content-type': 'application/json' },
      body: '{}',
    });
  };
  const syncUntilTotal = (expected) => eventually(async () => {
    await triggerSync();
    const { body } = await getJson('tokentracker-usage-summary');
    assert.equal(Number(body?.totals?.total_tokens), expected);
  });

  before(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'ccgui-tokentracker-'));
    home = path.join(workDir, 'home');
    const tmp = path.join(workDir, 'tmp');
    const prefix = path.join(workDir, 'npm-global');
    await mkdir(tmp, { recursive: true });

    const spec = await pinnedPackage();
    assert.match(spec, /^tokentracker-cli@[\w.-]+$/, `unexpected package spec: ${spec}`);
    const install = spawnSync(`npm install -g --prefix "${prefix}" ${spec} --no-audit --no-fund`, {
      encoding: 'utf8', shell: true,
    });
    assert.equal(install.status, 0, `npm install -g failed: ${install.stdout}${install.stderr}`);
    const globalRoot = process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');

    primaryTokens = await writeClaudeSessions(path.join(home, '.claude'), 'primary-project', 'primary', 'claude-sonnet-4-5', 6);

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [
      path.join(globalRoot, 'tokentracker-cli/bin/tracker.js'), 'serve', '--no-open', '--port', String(port),
    ], { env: isolatedEnv(home, tmp), stdio: 'ignore' });
    await eventually(async () => {
      assert.equal((await fetch(`${base}/functions/tokentracker-user-status`)).status, 200);
    }, { timeout: 60_000 });
  });

  after(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.once('exit', resolve));
      server.kill();
      await exited;
    }
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('serves every endpoint the dashboard requests', async () => {
    await syncUntilTotal(primaryTokens);
    const projectKey = (await getJson('tokentracker-project-usage-summary')).body?.entries?.[0]?.project_key;
    for (const slug of await dashboardSlugs()) {
      if (slug === 'tokentracker-local-sync') {
        const response = await triggerSync();
        assert.equal(response.status, 200, slug);
        assert.equal((await response.json()).ok, true, slug);
        continue;
      }
      const params = slug === 'tokentracker-project-usage-detail' ? { ...range(), project_key: projectKey } : range();
      const { status, body } = await getJson(slug, params);
      assert.equal(status, 200, slug);
      assert.equal(typeof body, 'object', slug);
      assert.notEqual(body, null, slug);
    }
  });

  it('returns the fields the dashboard reads', async () => {
    await syncUntilTotal(primaryTokens);

    const { body: summary } = await getJson('tokentracker-usage-summary');
    for (const key of SUMMARY_TOTAL_FIELDS) assert.ok(key in summary.totals, `usage-summary totals.${key}`);

    const { body: daily } = await getJson('tokentracker-usage-daily');
    assert.ok(daily.data.length > 0, 'usage-daily data');
    assert.ok(daily.data.every((row) => typeof row.day === 'string'), 'usage-daily data[].day');

    const { body: hourly } = await getJson('tokentracker-usage-hourly', { day: yesterday(), tz: 'UTC', tz_offset_minutes: '0' });
    assert.ok(hourly.data.some((row) => typeof row.hour === 'string'), 'usage-hourly data[].hour');

    const { body: monthly } = await getJson('tokentracker-usage-monthly');
    assert.ok(monthly.data.some((row) => typeof row.month === 'string'), 'usage-monthly data[].month');

    const { body: heatmap } = await getJson('tokentracker-usage-heatmap');
    assert.ok(heatmap.weeks.flat().some((cell) => typeof cell?.day === 'string'), 'usage-heatmap weeks[][].day');

    const { body: breakdown } = await getJson('tokentracker-usage-model-breakdown');
    const source = breakdown.sources.find((entry) => entry.source === 'claude');
    assert.ok(source, 'usage-model-breakdown sources[].source');
    for (const key of SUMMARY_TOTAL_FIELDS) assert.ok(key in source.totals, `usage-model-breakdown sources[].totals.${key}`);
    assert.ok(source.models.some((model) => model.model === 'claude-sonnet-4-5' && 'total_tokens' in model.totals),
      'usage-model-breakdown sources[].models[].model / totals');

    const { body: projects } = await getJson('tokentracker-project-usage-summary');
    const project = projects.entries.find((entry) => typeof entry.project_key === 'string');
    assert.ok(project, 'project-usage-summary entries[].project_key');

    const { body: detail } = await getJson('tokentracker-project-usage-detail', { ...range(), project_key: project.project_key });
    for (const key of ['total_tokens', 'billable_total_tokens', 'input_tokens', 'cached_input_tokens']) {
      assert.ok(key in detail.totals, `project-usage-detail totals.${key}`);
    }
    assert.ok('days_active' in detail, 'project-usage-detail days_active');
    assert.ok('range_total_tokens' in detail, 'project-usage-detail range_total_tokens');
    assert.ok(Array.isArray(detail.sources), 'project-usage-detail sources');
    assert.ok(Array.isArray(detail.daily) && detail.daily.every((row) => typeof row.day === 'string'), 'project-usage-detail daily[].day');

    const { body: status } = await getJson('tokentracker-user-status', {});
    if (status.subscriptions !== undefined) {
      assert.ok(Array.isArray(status.subscriptions.items), 'user-status subscriptions.items');
    }
  });

  it('reports the sum of the four usage fields as the token total', async () => {
    await syncUntilTotal(primaryTokens);
  });

  it('includes extra Claude config directories from config.json scanRoots', async () => {
    const workClaude = path.join(workDir, 'work-claude');
    const workTokens = await writeClaudeSessions(workClaude, 'work-project', 'work', 'claude-haiku-4-5', 4);

    const configFile = path.join(home, '.tokentracker/tracker/config.json');
    await mkdir(path.dirname(configFile), { recursive: true });
    const config = JSON.parse(await readFile(configFile, 'utf8').catch(() => '{}'));
    await writeFile(configFile, JSON.stringify({ ...config, scanRoots: { claude: [workClaude] } }, null, 2));

    await syncUntilTotal(primaryTokens + workTokens);
    const { body } = await getJson('tokentracker-usage-model-breakdown');
    const models = (body.sources ?? []).flatMap((source) => (source.models ?? []).map((m) => m.model));
    assert.ok(models.includes('claude-haiku-4-5'), `work model missing from ${JSON.stringify(models)}`);
  });
});
