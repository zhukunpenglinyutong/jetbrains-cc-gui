import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Redirect HOME to a temp dir BEFORE the first call to getRealHomeDir().
// path-utils caches the resolved home on first invocation, so we lock in the
// override here and share the same temp HOME across all tests in this file.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHomeRaw = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-mcp-config-'));
const tempHome = fs.realpathSync(tempHomeRaw);
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const { loadMcpServersConfigAsRecord, loadMcpServersConfig } = await import('./config-loader.js');

const claudeJsonPath = path.join(tempHome, '.claude.json');

function writeConfig(obj) {
  fs.writeFileSync(claudeJsonPath, JSON.stringify(obj));
}

function clearConfig() {
  try { fs.unlinkSync(claudeJsonPath); } catch { /* not present */ }
}

test.after(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

test('loadMcpServersConfigAsRecord returns null when ~/.claude.json is missing', async () => {
  clearConfig();
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null when mcpServers is absent or empty', async () => {
  writeConfig({});
  assert.equal(await loadMcpServersConfigAsRecord(), null);

  writeConfig({ mcpServers: {} });
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null when every server is disabled', async () => {
  writeConfig({
    mcpServers: { foo: { command: 'node', args: ['s.js'] } },
    disabledMcpServers: ['foo']
  });
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns null on invalid JSON', async () => {
  fs.writeFileSync(claudeJsonPath, '{ this is not valid json');
  assert.equal(await loadMcpServersConfigAsRecord(), null);
});

test('loadMcpServersConfigAsRecord returns Record<name, config> for enabled servers', async () => {
  writeConfig({
    mcpServers: {
      stdio: { command: 'node', args: ['server.js'] },
      http: { url: 'http://localhost:3000' }
    }
  });
  const result = await loadMcpServersConfigAsRecord();
  assert.ok(result, 'expected a non-null record');
  assert.deepEqual(Object.keys(result).sort(), ['http', 'stdio']);
  assert.deepEqual(result.stdio, { command: 'node', args: ['server.js'] });
  assert.deepEqual(result.http, { url: 'http://localhost:3000' });
});

test('loadMcpServersConfigAsRecord skips invalid server configs but keeps valid ones', async () => {
  writeConfig({
    mcpServers: {
      good: { command: 'node' },
      noCommandOrUrl: { foo: 'bar' },
      badArgs: { command: 'node', args: 'not-an-array' }
    }
  });
  const result = await loadMcpServersConfigAsRecord();
  assert.ok(result, 'expected a non-null record');
  assert.deepEqual(Object.keys(result), ['good']);
});

test('loadMcpServersConfig still returns an array (empty on missing config)', async () => {
  clearConfig();
  const list = await loadMcpServersConfig();
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 0);
});

test('loadMcpServersConfigAsRecord expands ${VAR} from .claude/settings.local.json env', async () => {
  // Regression test for #1722: Claude Code expands ${VAR} in .mcp.json env
  // values from .claude/settings.local.json; the plugin passed them through
  // literally, so containers received DATABASE_URI=${NEXUS_MCP_DB_URI}.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-mcp-env-'));
  try {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.local.json'), JSON.stringify({
      env: { NEXUS_MCP_DB_URI: 'postgres://user:pass@localhost/db' }
    }));

    writeConfig({
      mcpServers: {
        postgres: {
          command: 'docker',
          args: ['run', '-i', '--rm', 'postgres-mcp'],
          env: { DATABASE_URI: '${NEXUS_MCP_DB_URI}', STATIC: 'plain' }
        }
      }
    });

    const result = await loadMcpServersConfigAsRecord(projectDir);
    assert.ok(result, 'expected a non-null record');
    assert.equal(result.postgres.env.DATABASE_URI, 'postgres://user:pass@localhost/db');
    assert.equal(result.postgres.env.STATIC, 'plain');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('loadMcpServersConfigAsRecord falls back to process env then leaves unresolved placeholders as-is', async () => {
  process.env.CCG_TEST_MCP_FALLBACK = 'from-process-env';
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-mcp-env2-'));
  try {
    writeConfig({
      mcpServers: {
        mixed: {
          command: 'docker',
          args: ['run', '-i', '--rm', 'some-mcp'],
          env: {
            FROM_PROCESS: '${CCG_TEST_MCP_FALLBACK}',
            UNRESOLVED: '${CCG_TEST_MCP_MISSING_VAR}'
          }
        }
      }
    });

    const result = await loadMcpServersConfigAsRecord(projectDir);
    assert.ok(result, 'expected a non-null record');
    assert.equal(result.mixed.env.FROM_PROCESS, 'from-process-env');
    // Unresolvable placeholders stay literal so misconfig is visible
    assert.equal(result.mixed.env.UNRESOLVED, '${CCG_TEST_MCP_MISSING_VAR}');
  } finally {
    delete process.env.CCG_TEST_MCP_FALLBACK;
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('loadMcpServersConfigAsRecord prefers project env over user settings.json env', async () => {
  // user settings env map
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(tempHome, '.claude', 'settings.json'), JSON.stringify({
    env: { SHARED_VAR: 'user-value', USER_ONLY: 'user-only-value' }
  }));

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-mcp-env3-'));
  try {
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.claude', 'settings.local.json'), JSON.stringify({
      env: { SHARED_VAR: 'project-value' }
    }));

    writeConfig({
      mcpServers: {
        layered: { command: 'docker', env: { A: '${SHARED_VAR}', B: '${USER_ONLY}' } }
      }
    });

    const result = await loadMcpServersConfigAsRecord(projectDir);
    assert.ok(result, 'expected a non-null record');
    assert.equal(result.layered.env.A, 'project-value');
    assert.equal(result.layered.env.B, 'user-only-value');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(path.join(tempHome, '.claude'), { recursive: true, force: true });
  }
});
