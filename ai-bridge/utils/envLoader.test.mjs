import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import the module under test (ESM)
import {
  validateEnvFilePath,
  loadEnvFile,
  filterDangerousEnvVars,
  parseEnvContent,
  applyEnvFileVars,
} from './envLoader.js';

// We need to import isDangerousEnvVar to test integration
import { isDangerousEnvVar, isEnvFileDeniedEnvVar } from '../config/api-config.js';

describe('envLoader.js', () => {
  describe('validateEnvFilePath', () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envloader-test-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    test('rejects null path', async () => {
      const result = await validateEnvFilePath(null, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error);
    });

    test('rejects undefined path', async () => {
      const result = await validateEnvFilePath(undefined, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error);
    });

    test('rejects empty string path', async () => {
      const result = await validateEnvFilePath('', tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error);
    });

    test('rejects non-string path', async () => {
      const result = await validateEnvFilePath(123, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error);
    });

    test('rejects path with null byte (path injection)', async () => {
      const result = await validateEnvFilePath('test\0.env', tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('null byte'));
    });

    test('rejects path traversal via relative path with ..', async () => {
      const result = await validateEnvFilePath('../../etc/passwd', tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('outside project directory'));
    });

    test('rejects path traversal via ../.env', async () => {
      const result = await validateEnvFilePath('../.env', tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('outside project directory'));
    });

    test('rejects path that escapes base dir via absolute path', async () => {
      // Absolute path outside baseDir
      const result = await validateEnvFilePath('/etc/passwd', tempDir);
      assert.equal(result.path, null);
      // Could be either "outside project directory" or invalid extension
      assert.ok(result.error);
    });

    test('rejects file with disallowed extension', async () => {
      const envFilePath = path.join(tempDir, 'config.txt');
      fs.writeFileSync(envFilePath, 'TEST=value');

      const result = await validateEnvFilePath(envFilePath, tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('allowed env file patterns'));
    });

    test('rejects non-existent .env file', async () => {
      const result = await validateEnvFilePath('.env', tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('does not exist'));
    });

    test('accepts valid .env file within base dir', async () => {
      const envFilePath = path.join(tempDir, '.env');
      fs.writeFileSync(envFilePath, 'TEST=value\n');

      const result = await validateEnvFilePath(envFilePath, tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, envFilePath);
    });

    test('accepts valid .env.local file within base dir', async () => {
      const envFilePath = path.join(tempDir, '.env.local');
      fs.writeFileSync(envFilePath, 'TEST=value\n');

      const result = await validateEnvFilePath(envFilePath, tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, envFilePath);
    });

    test('accepts valid .env.production file within base dir', async () => {
      const envFilePath = path.join(tempDir, '.env.production');
      fs.writeFileSync(envFilePath, 'TEST=value\n');

      const result = await validateEnvFilePath(envFilePath, tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, envFilePath);
    });

    test('resolves relative path within base dir', async () => {
      const envFilePath = path.join(tempDir, '.env');
      fs.writeFileSync(envFilePath, 'TEST=value\n');

      const result = await validateEnvFilePath('.env', tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, envFilePath);
    });

    test('resolves nested subdirectory env file', async () => {
      const subDir = path.join(tempDir, 'subdir');
      fs.mkdirSync(subDir);
      const envFilePath = path.join(subDir, '.env');
      fs.writeFileSync(envFilePath, 'TEST=value\n');

      const result = await validateEnvFilePath(path.join('subdir', '.env'), tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, envFilePath);
    });

    test('rejects path with traversal that resolves outside after normalize', async () => {
      // A path like "validDir/../../escape.env" that resolves outside
      const subDir = path.join(tempDir, 'validDir');
      fs.mkdirSync(subDir);

      const result = await validateEnvFilePath('validDir/../../escape.env', tempDir);
      assert.equal(result.path, null);
      assert.ok(result.error?.includes('outside project directory'));
    });

    // The allowlist is a security boundary. The old predicate was a bare prefix
    // match (`baseName.startsWith(ext)`), so an author-chosen suffix rode in
    // behind any legitimate .env prefix.
    for (const fileName of ['.env.local.js', '.env.production.bak', '.env.test.sh', '.env.stagingX']) {
      test(`rejects ${fileName} — a prefix match would accept it`, async () => {
        const file = path.join(tempDir, fileName);
        fs.writeFileSync(file, 'KEY=value');

        const result = await validateEnvFilePath(file, tempDir);
        assert.equal(result.path, null);
        assert.ok(result.error?.includes('allowed env file patterns'));
      });
    }

    for (const fileName of ['.env', '.env.local', '.env.production']) {
      test(`accepts ${fileName}`, async () => {
        const file = path.join(tempDir, fileName);
        fs.writeFileSync(file, 'KEY=value');

        const result = await validateEnvFilePath(file, tempDir);
        assert.equal(result.error, null);
        assert.equal(result.path, file);
      });
    }

    test('fails closed when no base directory is supplied', async () => {
      // Containment checks are all gated on baseDir; without one the only gates
      // left would be the allowlist and existence, i.e. any absolute path to any
      // *.env* file on the machine. "No base dir" must be an error.
      const outsideFile = path.join(tempDir, '.env');
      fs.writeFileSync(outsideFile, 'SECRET=nope');

      for (const baseDir of [null, undefined, '']) {
        const result = await validateEnvFilePath(outsideFile, baseDir);
        assert.equal(result.path, null, `baseDir=${JSON.stringify(baseDir)}`);
        assert.equal(result.code, 'NO_BASE_DIR');
      }
    });

    test('exposes the realpath it validated alongside the logical path', async () => {
      // loadEnvFile must read the exact string that was checked for containment.
      const realFile = path.join(tempDir, 'real-secrets.env');
      fs.writeFileSync(realFile, 'KEY=secret\n');
      const link = path.join(tempDir, '.env.local');
      fs.symlinkSync(realFile, link);

      const result = await validateEnvFilePath(link, tempDir);
      assert.equal(result.error, null);
      assert.equal(result.path, link, 'callers keep the logical path');
      assert.equal(result.realPath, fs.realpathSync(realFile));
    });
  });

  describe('filterDangerousEnvVars', () => {
    test('filters NODE_OPTIONS', () => {
      const vars = {
        NODE_OPTIONS: '--require /malicious/script.js',
        API_KEY: 'safe-key',
      };
      const result = filterDangerousEnvVars(vars);
      assert.equal(result.NODE_OPTIONS, undefined);
      assert.equal(result.API_KEY, 'safe-key');
    });

    test('filters LD_PRELOAD', () => {
      const vars = {
        LD_PRELOAD: '/malicious/lib.so',
        SAFE_VAR: 'ok',
      };
      const result = filterDangerousEnvVars(vars);
      assert.equal(result.LD_PRELOAD, undefined);
      assert.equal(result.SAFE_VAR, 'ok');
    });

    test('filters DYLD_INSERT_LIBRARIES', () => {
      const vars = {
        DYLD_INSERT_LIBRARIES: '/malicious.dylib',
        SAFE: 'ok',
      };
      const result = filterDangerousEnvVars(vars);
      assert.equal(result.DYLD_INSERT_LIBRARIES, undefined);
      assert.equal(result.SAFE, 'ok');
    });

    test('filters BASH_ENV', () => {
      const vars = { BASH_ENV: '/malicious.sh', SAFE: 'ok' };
      const result = filterDangerousEnvVars(vars);
      assert.equal(result.BASH_ENV, undefined);
      assert.equal(result.SAFE, 'ok');
    });

    test('filters PYTHONPATH', () => {
      const vars = { PYTHONPATH: '/malicious/python', SAFE: 'ok' };
      const result = filterDangerousEnvVars(vars);
      assert.equal(result.PYTHONPATH, undefined);
      assert.equal(result.SAFE, 'ok');
    });

    test('filters GIT_SSH_COMMAND', () => {
      const vars = { GIT_SSH_COMMAND: 'ssh -o ProxyCommand=malicious', SAFE: 'ok' };
      const result = filterDangerousEnvVars(vars);
      assert.equal(result.GIT_SSH_COMMAND, undefined);
      assert.equal(result.SAFE, 'ok');
    });

    test('does not filter case-sensitive safe vars', () => {
      const vars = { safe_var: 'ok', AnotherSafe: 'ok2' };
      const result = filterDangerousEnvVars(vars);
      assert.deepEqual(result, vars);
    });

    test('filters PATH from env files while isDangerousEnvVar still allows it', () => {
      // PATH is deliberately absent from DANGEROUS_ENV_VAR_SET so the
      // IDE-supplied PATH in params.env keeps working (isDangerousEnvVar is what
      // that path checks). Env files get the extra denial, because every apply
      // site writes a var only when process.env's copy is unset/empty — so
      // "PATH=/tmp/attacker" in .env would hijack the binary search path of a
      // daemon that started without one.
      assert.equal(isDangerousEnvVar('PATH'), false);
      assert.equal(isEnvFileDeniedEnvVar('PATH'), true);
      assert.equal(isEnvFileDeniedEnvVar('path'), true, 'case-insensitive');
      assert.equal(filterDangerousEnvVars({ PATH: '/tmp/attacker', OK: 'v' }).PATH, undefined);
    });

    test('filters all dangerous var types from isDangerousEnvVar', () => {
      const allDangerous = [
        'NODE_OPTIONS',
        'NODE_REPL_EXTERNAL_MODULE',
        'NODE_EXTRA_CA_CERTS',
        'ELECTRON_RUN_AS_NODE',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'LD_AUDIT',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
        'DYLD_FRAMEWORK_PATH',
        'BASH_ENV',
        'ENV',
        'PERL5LIB',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'GIT_SSH_COMMAND',
        'GIT_EXTERNAL_DIFF',
      ];
      const vars = {};
      for (const v of allDangerous) {
        vars[v] = 'malicious';
      }
      vars.SAFE = 'ok';
      const result = filterDangerousEnvVars(vars);
      assert.equal(Object.keys(result).length, 1);
      assert.equal(result.SAFE, 'ok');
      for (const v of allDangerous) {
        assert.equal(result[v], undefined);
      }
    });

    test('handles empty object', () => {
      const result = filterDangerousEnvVars({});
      assert.deepEqual(result, {});
    });

    test('handles null input gracefully', () => {
      const result = filterDangerousEnvVars(null);
      assert.deepEqual(result, {});
    });

    test('handles undefined input gracefully', () => {
      const result = filterDangerousEnvVars(undefined);
      assert.deepEqual(result, {});
    });
  });

  describe('parseEnvContent', () => {
    test('parses simple KEY=VALUE', () => {
      const result = parseEnvContent('KEY=value');
      assert.deepEqual(result, { KEY: 'value' });
    });

    test('skips comments', () => {
      const content = '# This is a comment\nKEY=value\n# Another comment';
      const result = parseEnvContent(content);
      assert.deepEqual(result, { KEY: 'value' });
    });

    test('skips blank lines', () => {
      const content = '\n\nKEY=value\n\n';
      const result = parseEnvContent(content);
      assert.deepEqual(result, { KEY: 'value' });
    });

    test('handles quoted values', () => {
      assert.deepEqual(parseEnvContent('KEY="value"'), { KEY: 'value' });
      assert.deepEqual(parseEnvContent("KEY='value'"), { KEY: 'value' });
    });

    test('handles export prefix', () => {
      const result = parseEnvContent('export KEY=value');
      assert.deepEqual(result, { KEY: 'value' });
    });

    test('handles multiple variables', () => {
      const content = 'KEY1=val1\nKEY2=val2\nKEY3=val3';
      const result = parseEnvContent(content);
      assert.deepEqual(result, { KEY1: 'val1', KEY2: 'val2', KEY3: 'val3' });
    });

    test('strips BOM', () => {
      const content = '﻿KEY=value';
      const result = parseEnvContent(content);
      assert.deepEqual(result, { KEY: 'value' });
    });

    test('handles empty content', () => {
      assert.deepEqual(parseEnvContent(''), {});
      assert.deepEqual(parseEnvContent(null), {});
      assert.deepEqual(parseEnvContent(undefined), {});
    });

    test('skips lines without equals sign', () => {
      const content = 'INVALID LINE\nKEY=value\n123';
      const result = parseEnvContent(content);
      assert.deepEqual(result, { KEY: 'value' });
    });

    test('skips names that are not valid env identifiers', () => {
      // Defence in depth, not a closed hole: values are primitives (so the
      // classic __proto__ prototype-pollution trick cannot fire) and children are
      // spawned via spawn() rather than a shell (so no command injection). But a
      // key no child process could read is noise, and refusing it keeps the
      // boundary honest for future consumers of the map.
      const result = parseEnvContent([
        'FOO BAR=x',
        'A-B=c',
        '1KEY=v',
        'KEY WITH SPACE=v',
        'KÉY=v',
        'GOOD_KEY=v',
        '_LEADING_UNDERSCORE=v',
        'mixedCase99=v',
      ].join('\n'));

      assert.deepEqual(result, {
        GOOD_KEY: 'v',
        _LEADING_UNDERSCORE: 'v',
        mixedCase99: 'v',
      });
    });
  });

  describe('applyEnvFileVars', () => {
    const ENV_KEYS = ['APPLY_TEST_A', 'APPLY_TEST_B', 'APPLY_TEST_PATH'];

    afterEach(() => {
      for (const key of ENV_KEYS) delete process.env[key];
    });

    test('sets only unset vars and reports names only', () => {
      process.env.APPLY_TEST_B = 'already-here';

      const { applied, skipped } = applyEnvFileVars({
        APPLY_TEST_A: 'from-env-file',
        APPLY_TEST_B: 'from-env-file',
      });

      assert.equal(process.env.APPLY_TEST_A, 'from-env-file');
      assert.equal(process.env.APPLY_TEST_B, 'already-here', 'must not overwrite');
      assert.deepEqual(applied, ['APPLY_TEST_A']);
      assert.deepEqual(skipped, ['APPLY_TEST_B']);
    });

    test('overwrites an empty existing value', () => {
      // The apply rule is "unset or empty", not merely "absent".
      process.env.APPLY_TEST_A = '';
      applyEnvFileVars({ APPLY_TEST_A: 'from-env-file' });
      assert.equal(process.env.APPLY_TEST_A, 'from-env-file');
    });

    test('never writes PATH', () => {
      delete process.env.APPLY_TEST_PATH;
      process.env.PATH = '';
      try {
        const { applied, skipped } = applyEnvFileVars({ PATH: '/tmp/attacker' });
        assert.equal(process.env.PATH, '', 'PATH must not be overwritten from an env file');
        assert.deepEqual(applied, []);
        assert.deepEqual(skipped, ['PATH']);
      } finally {
        process.env.PATH = process.env.PATH || '';
      }
    });

    test('records prior values into savedEnv only for changed vars', () => {
      process.env.APPLY_TEST_B = 'already-here';
      const savedEnv = {};

      applyEnvFileVars({ APPLY_TEST_A: 'from-env-file', APPLY_TEST_B: 'other' }, { savedEnv });

      assert.deepEqual(savedEnv, { APPLY_TEST_A: undefined });
    });

    test('tolerates missing input', () => {
      assert.deepEqual(applyEnvFileVars(null), { applied: [], skipped: [] });
      assert.deepEqual(applyEnvFileVars(undefined), { applied: [], skipped: [] });
    });
  });

  describe('loadEnvFile', () => {
    let tempDir;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envloader-test-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    test('loads valid env file and filters dangerous vars', async () => {
      const envPath = path.join(tempDir, '.env');
      fs.writeFileSync(envPath, 'NODE_OPTIONS=--require evil.js\nAPI_KEY=secret\n');

      const result = await loadEnvFile(envPath, tempDir);
      assert.equal(result.NODE_OPTIONS, undefined);
      assert.equal(result.API_KEY, 'secret');
    });

    test('returns empty object for non-existent file', async () => {
      const result = await loadEnvFile('.env.nonexistent', tempDir);
      assert.deepEqual(result, {});
    });

    test('returns empty object for path traversal attempt', async () => {
      const result = await loadEnvFile('../../etc/passwd', tempDir);
      assert.deepEqual(result, {});
    });
  });

  describe('ALLOWED_ENV_EXTENSIONS', () => {
    // Note: ALLOWED_ENV_EXTENSIONS is internal (not exported). Tests for
    // extension validation live in the validateEnvFilePath suite above.
  });
});
