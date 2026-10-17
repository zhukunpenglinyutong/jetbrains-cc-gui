import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import {
  selectWorkingDirectory,
  isBridgeDirectory,
  normalizePathForComparison,
  getClaudeProjectKey,
  getClaudeProjectSessionFilePath,
  getClaudeProjectSessionFileCandidates,
  isMainEntryModule,
} from './path-utils.js';

// This test sits in <bridge>/utils/, so the bridge install dir is one level up.
// Resolve symlinks the same way path-utils.js does so equality checks stay stable.
function resolveBridgeDir() {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}
const BRIDGE_DIR = resolveBridgeDir();

const samePath = (a, b) => normalizePathForComparison(a) === normalizePathForComparison(b);

/**
 * Runs `fn` with IDEA_PROJECT_PATH / PROJECT_PATH cleared, restoring them after
 * so working-directory resolution is exercised without ambient project env.
 */
function withoutProjectEnv(fn) {
  const keys = ['IDEA_PROJECT_PATH', 'PROJECT_PATH'];
  const saved = {};
  for (const k of keys) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('isBridgeDirectory matches the ai-bridge install dir', () => {
  assert.equal(isBridgeDirectory(BRIDGE_DIR), true);
});

test('isBridgeDirectory rejects unrelated, empty, and nullish paths', () => {
  assert.equal(isBridgeDirectory(homedir()), false);
  assert.equal(isBridgeDirectory(''), false);
  assert.equal(isBridgeDirectory(null), false);
  assert.equal(isBridgeDirectory(undefined), false);
});

test('selectWorkingDirectory never resolves to the bridge dir (issue #1343)', () => {
  withoutProjectEnv(() => {
    const result = selectWorkingDirectory(BRIDGE_DIR);
    assert.ok(!samePath(result, BRIDGE_DIR), `expected a non-bridge dir, got ${result}`);
  });
});

test('selectWorkingDirectory prefers IDEA_PROJECT_PATH over a bridge-dir request', () => {
  withoutProjectEnv(() => {
    const projectPath = homedir(); // a real, existing dir that is not the bridge dir
    process.env.IDEA_PROJECT_PATH = projectPath;
    assert.ok(samePath(selectWorkingDirectory(BRIDGE_DIR), projectPath));
  });
});

test('selectWorkingDirectory returns a valid requested cwd unchanged', () => {
  withoutProjectEnv(() => {
    const home = homedir();
    assert.ok(samePath(selectWorkingDirectory(home), resolve(home)));
  });
});

test('selectWorkingDirectory rejects IDEA_PROJECT_PATH set to bridge dir (issue #1343)', () => {
  // Simulates a developer working on the bridge itself with IDEA_PROJECT_PATH
  // pointing at the bridge root — the fallback must not return the bridge dir.
  const saved = process.env.IDEA_PROJECT_PATH;
  process.env.IDEA_PROJECT_PATH = BRIDGE_DIR;
  delete process.env.PROJECT_PATH;
  try {
    const result = selectWorkingDirectory('');
    assert.ok(!samePath(result, BRIDGE_DIR), `expected non-bridge fallback, got ${result}`);
  } finally {
    if (saved === undefined) delete process.env.IDEA_PROJECT_PATH;
    else process.env.IDEA_PROJECT_PATH = saved;
  }
});

test('selectWorkingDirectory skips bridge dir when it appears as process.cwd() candidate', () => {
  // When run from the bridge dir (typical daemon startup), an empty requestedCwd
  // must not resolve to the bridge dir.
  withoutProjectEnv(() => {
    if (!samePath(process.cwd(), BRIDGE_DIR)) return; // only meaningful from bridge dir
    const result = selectWorkingDirectory('');
    assert.ok(!samePath(result, BRIDGE_DIR), `expected non-bridge dir, got ${result}`);
  });
});

test('getClaudeProjectKey matches the session writer for common paths', () => {
  assert.equal(getClaudeProjectKey('D:\\Projects\\My Project'), 'D--Projects-My-Project');
  assert.equal(getClaudeProjectKey('/Users/test/demo'), '-Users-test-demo');
});

test('getClaudeProjectKey resolves symlinked project paths like the CLI (issue #1789)', () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-key-real-'));
  const linkDir = `${realDir}-link`;
  try {
    let linkCreated = true;
    try {
      fs.symlinkSync(realDir, linkDir, 'dir');
    } catch {
      linkCreated = false;
    }
    if (!linkCreated) return; // platform refused to create a symlink
    assert.equal(getClaudeProjectKey(linkDir), realDir.replace(/[^a-zA-Z0-9]/g, '-'));
    const sessionFile = getClaudeProjectSessionFilePath('session-1', linkDir);
    assert.ok(sessionFile.includes(realDir.replace(/[^a-zA-Z0-9]/g, '-')));
    const candidates = getClaudeProjectSessionFileCandidates('session-1', linkDir);
    assert.equal(candidates.length, 2);
    assert.ok(candidates[1].includes(linkDir.replace(/[^a-zA-Z0-9]/g, '-')));
  } finally {
    try {
      fs.unlinkSync(linkDir);
    } catch {
      // link may not exist when creation failed
    }
    fs.rmSync(realDir, { recursive: true, force: true });
  }
});

test('getClaudeProjectKey falls back to raw encoding for nonexistent paths', () => {
  const ghost = path.join(os.tmpdir(), 'cc-gui-nonexistent-ghost');
  assert.equal(getClaudeProjectKey(ghost), ghost.replace(/[^a-zA-Z0-9]/g, '-'));
});

test('getClaudeProjectKey preserves the complete key for long paths', () => {
  const longPath = `C:\\Users\\name\\${'deep\\'.repeat(60)}project`;
  const projectKey = getClaudeProjectKey(longPath);

  assert.equal(projectKey, longPath.replace(/[^a-zA-Z0-9]/g, '-'));
  assert.ok(projectKey.length > 200);
});

test('getClaudeProjectSessionFilePath uses the shared project key', () => {
  const cwd = `C:\\Users\\name\\${'deep\\'.repeat(60)}project`;
  const sessionFile = getClaudeProjectSessionFilePath('session-1', cwd);

  assert.ok(sessionFile.includes(getClaudeProjectKey(cwd)));
  assert.ok(sessionFile.endsWith('session-1.jsonl'));
});

test('getClaudeProjectSessionFilePath rejects path-like session IDs', () => {
  assert.throws(
    () => getClaudeProjectSessionFilePath('../outside', 'C:\\project'),
    /Invalid session ID/,
  );
});

test('isMainEntryModule returns false for non-entry imports', () => {
  // Under node --test, argv[1] is this test file, so this file's own
  // import.meta.url would be the entry. Pass the URL of another loaded
  // module (path-utils.js itself) to exercise the realpath comparison
  // and prove a non-entry module is rejected.
  const nonEntryUrl = pathToFileURL(resolve(BRIDGE_DIR, 'utils', 'path-utils.js')).href;
  assert.equal(isMainEntryModule(nonEntryUrl), false);
});

test('isMainEntryModule survives a junctioned entry path', (t) => {
  // Regression: launching through a Windows junction/symlink must still count
  // as the entry script. Node realpaths the entry module's URL, so the naive
  // URL comparison fails when the launcher passes the junctioned path
  // (JetBrains configs migrated to another drive via AppData\Roaming junction).
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-entry-'));
  try {
    const realDir = path.join(fixtureDir, 'real');
    const linkDir = path.join(fixtureDir, 'link');
    fs.mkdirSync(realDir);
    const entryPath = path.join(realDir, 'entry.mjs');
    fs.writeFileSync(entryPath, [
      `import { isMainEntryModule } from ${JSON.stringify(pathToFileURL(resolve(BRIDGE_DIR, 'utils', 'path-utils.js')).href)};`,
      'console.log(isMainEntryModule(import.meta.url) ? "ENTRY" : "NOT_ENTRY");',
      '',
    ].join('\n'));
    let linkPath = null;
    try {
      fs.symlinkSync(realDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
      linkPath = path.join(linkDir, 'entry.mjs');
    } catch {
      t.skip('symlink/junction creation not permitted on this host');
    }
    const run = (entry) => spawnSync(process.execPath, [entry], { encoding: 'utf8' });
    assert.equal(run(entryPath).stdout.trim(), 'ENTRY');
    if (linkPath) {
      assert.equal(run(linkPath).stdout.trim(), 'ENTRY');
    }
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
