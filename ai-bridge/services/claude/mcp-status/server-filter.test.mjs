import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { filterServersByName, getMcpServersStatus } from './index.js';

/**
 * Shape mirrors what loadAllMcpServersInfo() returns (config-loader.js):
 *   enabled:  [{ name, config }]
 *   disabled: [name]        <- plain strings
 *   invalid:  [{ name, reason }]
 */
function makeServers() {
  return {
    enabled: [
      { name: 'alpha', config: { command: 'node', args: ['a.js'] } },
      { name: 'beta', config: { url: 'https://example.test/mcp' } },
      { name: 'gamma', config: { command: 'python', args: ['g.py'] } },
    ],
    disabled: ['delta'],
    invalid: [{ name: 'epsilon', reason: 'Missing command or url' }],
  };
}

test('filterServersByName keeps everything when no filter is given', () => {
  const servers = makeServers();

  assert.equal(filterServersByName(servers, null), servers);
  assert.equal(filterServersByName(servers, undefined), servers);
  assert.equal(filterServersByName(servers, []), servers);
});

test('filterServersByName narrows every bucket to the requested names', () => {
  const result = filterServersByName(makeServers(), ['beta', 'delta']);

  assert.deepEqual(result.enabled.map((s) => s.name), ['beta']);
  assert.deepEqual(result.disabled, ['delta']);
  assert.deepEqual(result.invalid, []);
});

test('filterServersByName keeps the config and reason payloads intact', () => {
  const result = filterServersByName(makeServers(), ['alpha', 'epsilon']);

  assert.equal(result.enabled[0].config.command, 'node');
  assert.equal(result.invalid[0].reason, 'Missing command or url');
});

test('filterServersByName drops servers that are not requested', () => {
  const result = filterServersByName(makeServers(), ['gamma']);

  // The point of the filter: nothing outside the request gets verified, which
  // would otherwise spawn a process / hit the network for every other server.
  assert.equal(result.enabled.length, 1);
  assert.equal(result.enabled[0].name, 'gamma');
  assert.equal(result.disabled.length, 0);
  assert.equal(result.invalid.length, 0);
});

test('filterServersByName returns empty buckets for an unknown name', () => {
  const result = filterServersByName(makeServers(), ['does-not-exist']);

  assert.deepEqual(result, { enabled: [], disabled: [], invalid: [] });
});

test('filterServersByName does not mutate the input', () => {
  const servers = makeServers();

  filterServersByName(servers, ['alpha']);

  assert.equal(servers.enabled.length, 3);
  assert.deepEqual(servers.disabled, ['delta']);
  assert.equal(servers.invalid.length, 1);
});

/**
 * End-to-end guard for the point of the filter: a targeted status request must not
 * spawn the processes of servers it was not asked about.
 */
test('getMcpServersStatus only spawns the requested server', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccgui-status-filter-'));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const markerDir = path.join(home, 'markers');
  fs.mkdirSync(markerDir);

  // The verifier runs children with a sanitized env, so the marker path is baked
  // into the script rather than passed through the environment.
  const writeProbe = (name) => {
    const scriptPath = path.join(home, `${name}.cjs`);
    const marker = path.join(markerDir, name);
    fs.writeFileSync(scriptPath,
      `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x');setTimeout(() => process.exit(0), 30);`);
    return { command: process.execPath, args: [scriptPath] };
  };

  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: {
      'untouched-server': writeProbe('untouched-server'),
      'target-server': writeProbe('target-server'),
    },
  }));

  const spawned = () => fs.readdirSync(markerDir).sort();

  const all = await getMcpServersStatus(home);
  assert.deepEqual(all.map((s) => s.name).sort(), ['target-server', 'untouched-server']);
  assert.deepEqual(spawned(), ['target-server', 'untouched-server'], 'full check spawns everything');

  for (const marker of spawned()) {
    fs.unlinkSync(path.join(markerDir, marker));
  }

  const targeted = await getMcpServersStatus(home, ['target-server']);
  assert.deepEqual(targeted.map((s) => s.name), ['target-server']);
  assert.deepEqual(spawned(), ['target-server'], 'the other server must not be spawned');
});
