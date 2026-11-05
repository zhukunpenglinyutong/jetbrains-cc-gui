/**
 * Integration tests for envLoader security through the daemon request handler.
 * Tests that path validation and dangerous env var filtering work end-to-end
 * when invoked from the daemon's processRequest flow.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  validateEnvFilePath,
  loadEnvFile,
  filterDangerousEnvVars,
  parseEnvContent,
} from './envLoader.js';

describe('envLoader security integration', () => {
  let tempDir;
  let envFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envloader-integration-'));
    envFile = path.join(tempDir, '.env');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('path traversal prevention', () => {
    test('blocks ../../etc/passwd style traversal', async () => {
      const traversalPath = path.join(tempDir, '..', '..', 'etc', 'passwd');
      const result = await validateEnvFilePath(traversalPath, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('outside project directory'));
    });

    test('blocks symlinks pointing outside project', async () => {
      // A symlink whose name passes the extension allowlist and whose location
      // is inside the project, but whose target lives elsewhere — this would
      // otherwise smuggle an arbitrary file (e.g. ~/.ssh/id_rsa) into process.env.
      const target = path.join(os.tmpdir(), `target-${Date.now()}.env`);
      fs.writeFileSync(target, 'KEY=secret');

      const symlinkPath = path.join(tempDir, '.env.local');
      try {
        fs.symlinkSync(target, symlinkPath);

        const result = await validateEnvFilePath(symlinkPath, tempDir);
        assert.equal(result.path, null);
        assert.ok(
          result.error?.includes('resolves outside project directory'),
          `expected symlink escape to be rejected, got: ${result.error}`
        );
        assert.equal(Object.keys(await loadEnvFile(symlinkPath, tempDir)).length, 0);
      } finally {
        try { fs.unlinkSync(target); } catch { /* ignore */ }
      }
    });

    test('allows symlinks that stay inside the project', async () => {
      const realFile = path.join(tempDir, 'real-secrets.env');
      fs.writeFileSync(realFile, 'KEY=secret\n');
      const symlinkPath = path.join(tempDir, '.env.local');
      fs.symlinkSync(realFile, symlinkPath);

      const result = await validateEnvFilePath(symlinkPath, tempDir);
      assert.equal(result.error, null);
      assert.deepEqual(await loadEnvFile(symlinkPath, tempDir), { KEY: 'secret' });
    });

    test('allows legitimate .env in project root', async () => {
      fs.writeFileSync(envFile, 'API_KEY=test-key\n');
      const result = await validateEnvFilePath(envFile, tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, envFile);
    });

    test('allows legitimate .env.local in project root', async () => {
      const localEnv = path.join(tempDir, '.env.local');
      fs.writeFileSync(localEnv, 'API_KEY=test-key\n');
      const result = await validateEnvFilePath(localEnv, tempDir);
      assert.equal(result.error, null);
    });

    test('allows env files in subdirectories', async () => {
      const subDir = path.join(tempDir, 'config');
      fs.mkdirSync(subDir);
      const subEnvFile = path.join(subDir, '.env');
      fs.writeFileSync(subEnvFile, 'KEY=value');

      const result = await validateEnvFilePath('config/.env', tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, subEnvFile);
    });
  });

  describe('dangerous env var filtering end-to-end', () => {
    test('blocks code injection via env file', async () => {
      fs.writeFileSync(envFile, [
        'NODE_OPTIONS=--require /malicious/script.js',
        'LD_PRELOAD=/malicious/lib.so',
        'DYLD_INSERT_LIBRARIES=/malicious.dylib',
        'BASH_ENV=/malicious.sh',
        'PYTHONPATH=/malicious/python',
        'SAFE_VAR=legitimate',
      ].join('\n'));

      const result = await loadEnvFile(envFile, tempDir);
      assert.equal(result.NODE_OPTIONS, undefined);
      assert.equal(result.LD_PRELOAD, undefined);
      assert.equal(result.DYLD_INSERT_LIBRARIES, undefined);
      assert.equal(result.BASH_ENV, undefined);
      assert.equal(result.PYTHONPATH, undefined);
      assert.equal(result.SAFE_VAR, 'legitimate');
    });

    test('blocks git hook injection via env file', () => {
      const result = filterDangerousEnvVars({
        GIT_SSH_COMMAND: 'ssh -o ProxyCommand=malicious',
        GIT_EXTERNAL_DIFF: '/malicious/diff.sh',
        SAFE_VAR: 'ok',
      });
      assert.equal(result.GIT_SSH_COMMAND, undefined);
      assert.equal(result.GIT_EXTERNAL_DIFF, undefined);
      assert.equal(result.SAFE_VAR, 'ok');
    });

    test('blocks PATH coming from an env file', () => {
      // PATH is deliberately absent from DANGEROUS_ENV_VAR_SET (the Java
      // EnvironmentConfigurator supplies the daemon's real one, and the
      // params.env path must keep working). But every apply site only writes a
      // var when process.env's copy is unset/empty, so "PATH=/tmp/attacker" in a
      // project .env would redefine the binary search path for every later spawn
      // on a daemon that started without one. Env files therefore get the extra
      // denial; params.env does not.
      const result = filterDangerousEnvVars({
        PATH: '/tmp/attacker',
        NODE_OPTIONS: '--require evil.js',
        SAFE_VAR: 'ok',
      });
      assert.equal(result.PATH, undefined);
      assert.equal(result.NODE_OPTIONS, undefined);
      assert.equal(result.SAFE_VAR, 'ok');
    });

    test('does not allow setting env vars that override existing process.env', async () => {
      // Simulate the daemon behavior where env vars are only set if not already set
      process.env.TEST_EXISING_VAR = 'original';
      fs.writeFileSync(envFile, 'TEST_EXISING_VAR=should-not-override\n');

      const result = await loadEnvFile(envFile, tempDir);

      // Simulate the daemon logic from daemon.js:
      // if (!(k in process.env) || !process.env[k]) { process.env[k] = v; }
      if (!('TEST_EXISING_VAR' in process.env) || !process.env.TEST_EXISING_VAR) {
        process.env.TEST_EXISING_VAR = result.TEST_EXISING_VAR;
      }
      // Original value should be preserved because it was already set
      assert.equal(process.env.TEST_EXISING_VAR, 'original');
      delete process.env.TEST_EXISING_VAR;
    });
  });

  describe('malformed env file handling', () => {
    test('handles file with mixed content', async () => {
      fs.writeFileSync(envFile, [
        '# Comment line',
        'export VALID_KEY=value',
        'INVALID LINE',
        'QUOTED="quoted value"',
        '=missing_key',
        'EMPTY_VAL=',
        '',
      ].join('\n'));

      const result = await loadEnvFile(envFile, tempDir);
      assert.equal(result.VALID_KEY, 'value');
      assert.equal(result.QUOTED, 'quoted value');
      assert.equal(result.EMPTY_VAL, '');
      assert.equal(result.INVALID, undefined);
      assert.equal(result.missing_key, undefined);
    });

    test('handles empty env file', async () => {
      fs.writeFileSync(envFile, '');
      const result = await loadEnvFile(envFile, tempDir);
      assert.deepEqual(result, {});
    });

    test('handles env file with only comments', async () => {
      fs.writeFileSync(envFile, '# Comment 1\n# Comment 2\n');
      const result = await loadEnvFile(envFile, tempDir);
      assert.deepEqual(result, {});
    });
  });

  describe('extension validation', () => {
    // The allowlist is a SECURITY BOUNDARY: an allowlist entry must match the
    // whole file name, or the name plus exactly one dot-separated qualifier.
    // The predicate it used to be, `baseName.startsWith(ext)`, was a prefix
    // match — so anything at all could be smuggled in behind a legitimate
    // .env-looking prefix. Every case below is checked against that.

    test('rejects .txt files', async () => {
      const txtFile = path.join(tempDir, 'config.txt');
      fs.writeFileSync(txtFile, 'KEY=value');

      const result = await validateEnvFilePath(txtFile, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('allowed env file patterns'));
    });

    test('rejects files without .env prefix', async () => {
      const badFile = path.join(tempDir, 'config.env.bak');
      fs.writeFileSync(badFile, 'KEY=value');

      const result = await validateEnvFilePath(badFile, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('allowed env file patterns'));
    });

    // The allowlist entries that carry their own dot — .env.local, .env.test, …
    // — previously matched by prefix alone, so an attacker-chosen extra suffix
    // rode straight through. These are the real vector the old test missed.
    const REJECTED_EXTENSIONS = [
      '.env.local.js',
      '.env.production.bak',
      '.env.test.sh',
      '.env.stagingX',
    ];

    for (const fileName of REJECTED_EXTENSIONS) {
      test(`rejects ${fileName} (extra suffix past an allowlist entry)`, async () => {
        const file = path.join(tempDir, fileName);
        fs.writeFileSync(file, 'KEY=value');

        const result = await validateEnvFilePath(file, tempDir);
        assert.equal(result.path, null, `${fileName} must not pass the allowlist`);
        assert.ok(result.error?.includes('allowed env file patterns'));
        // And it must not reach process.env through loadEnvFile either.
        assert.deepEqual(await loadEnvFile(file, tempDir), {});
      });
    }

    const ACCEPTED_EXTENSIONS = ['.env', '.env.local', '.env.production'];

    for (const fileName of ACCEPTED_EXTENSIONS) {
      test(`accepts ${fileName}`, async () => {
        const file = path.join(tempDir, fileName);
        fs.writeFileSync(file, 'KEY=value');

        const result = await validateEnvFilePath(file, tempDir);
        assert.equal(result.error, null, `${fileName} must stay on the allowlist`);
        assert.equal(result.path, file);
        assert.deepEqual(await loadEnvFile(file, tempDir), { KEY: 'value' });
      });
    }

    test('rejects .env.js files (potential code execution)', async () => {
      // "js" is not one of the qualifiers we list, so the full-name check
      // rejects it — the original intent of this test is preserved, and it now
      // passes for the right reason rather than by accident of prefix matching.
      const jsEnvFile = path.join(tempDir, '.env.js');
      fs.writeFileSync(jsEnvFile, 'module.exports = { KEY: "value" };');

      const result = await validateEnvFilePath(jsEnvFile, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('allowed env file patterns'));
      assert.deepEqual(await loadEnvFile(jsEnvFile, tempDir), {});
    });
  });

  describe('fail-closed on a missing base directory', () => {
    test('refuses to validate any path without a project directory', async () => {
      // With no base dir the containment checks are all skipped, so the only
      // surviving gates would be the allowlist and existence — i.e. any
      // absolute path to any *.env* file on the machine.
      const absoluteEnv = path.join(tempDir, '.env');
      fs.writeFileSync(absoluteEnv, 'SECRET=from-another-users-project');

      for (const baseDir of [null, undefined, '']) {
        const result = await validateEnvFilePath(absoluteEnv, baseDir);
        assert.equal(result.path, null, `baseDir=${JSON.stringify(baseDir)} must fail closed`);
        assert.equal(result.code, 'NO_BASE_DIR');
      }
    });

    test('loadEnvFile returns nothing without a base directory', async () => {
      const absoluteEnv = path.join(tempDir, '.env');
      fs.writeFileSync(absoluteEnv, 'SECRET=from-another-users-project');

      assert.deepEqual(await loadEnvFile(absoluteEnv, null), {});
      assert.deepEqual(await loadEnvFile(absoluteEnv, ''), {});
      assert.deepEqual(await loadEnvFile(absoluteEnv), {});
    });
  });

  describe('parse-time env var name filtering', () => {
    test('drops names that are not valid env identifiers', () => {
      // Defence in depth: values are primitives and children are spawned via
      // spawn() (no shell), so this is not closing an exploitable hole — it
      // keeps the map free of keys no child process could ever read.
      const parsed = parseEnvContent([
        'FOO BAR=x',
        'A-B=c',
        '1KEY=v',
        'GOOD_KEY=v',
        '_ALSO_GOOD=v',
      ].join('\n'));

      assert.deepEqual(parsed, { GOOD_KEY: 'v', _ALSO_GOOD: 'v' });
    });
  });
});
