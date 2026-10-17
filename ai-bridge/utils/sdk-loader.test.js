import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCodexCliStatus,
  getInstalledSdkVersion,
  isCodexSdkAvailable,
} from './sdk-loader.js';

// The resolver derives the triple and binary name from the running platform,
// so the fixtures must mirror the official npm layout for THIS platform.
const ARCH_KEY = process.arch === 'arm64' ? 'arm64' : 'x64';
const CPU = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const TRIPLE = process.platform === 'win32' ? `${CPU}-pc-windows-msvc`
  : process.platform === 'darwin' ? `${CPU}-apple-darwin`
  : `${CPU}-unknown-linux-musl`;
const PLATFORM_PACKAGE = `codex-${process.platform}-${ARCH_KEY}`;
const BINARY = process.platform === 'win32' ? 'codex.exe' : 'codex';

function makeDepsBase() {
  return mkdtempSync(join(tmpdir(), 'sdk-loader-codex-'));
}

function writePackageJson(dir, version) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@openai/codex', version }),
    'utf8'
  );
}

test('a legacy directory can supply an existing CLI without managing its SDK', () => {
  const depsBase = makeDepsBase();
  try {
    // Legacy layout: @openai/codex-sdk plus the hoisted CLI beside it.
    const sdkPkg = join(depsBase, 'codex-sdk', 'node_modules', '@openai', 'codex-sdk');
    writePackageJson(sdkPkg, '0.145.0');
    const cliPkg = join(depsBase, 'codex-sdk', 'node_modules', '@openai', 'codex');
    writePackageJson(cliPkg, '0.145.0');
    const binaryDir = join(
      depsBase, 'codex-sdk', 'node_modules', '@openai', PLATFORM_PACKAGE,
      'vendor', TRIPLE, 'bin');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, BINARY), 'binary', 'utf8');

    assert.equal(isCodexSdkAvailable(depsBase), true, 'the legacy directory contains a real CLI');
    const cli = getCodexCliStatus(depsBase);
    assert.equal(cli.status, 'resolved');
    assert.equal(cli.source, 'legacy');
    assert.equal(cli.kind, 'native-binary');
    assert.equal(cli.version, '0.145.0');
    assert.ok(cli.command[0].endsWith(BINARY));
  } finally {
    rmSync(depsBase, { recursive: true, force: true });
  }
});

test('new @openai/codex install satisfies the dependency without any SDK package', () => {
  const depsBase = makeDepsBase();
  try {
    // New install: only the CLI package, no @openai/codex-sdk anywhere.
    const cliPkg = join(depsBase, 'codex-sdk', 'node_modules', '@openai', 'codex');
    writePackageJson(cliPkg, '0.111.0');
    const binaryDir = join(
      cliPkg, 'node_modules', '@openai', PLATFORM_PACKAGE,
      'vendor', TRIPLE, 'codex');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, BINARY), 'binary', 'utf8');

    assert.equal(isCodexSdkAvailable(depsBase), true);
    const cli = getCodexCliStatus(depsBase);
    assert.equal(cli.status, 'resolved');
    assert.equal(cli.version, '0.111.0');
    // The command points at the CLI package; the @openai/codex-sdk npm
    // package (the legacy TypeScript SDK) is not part of the path.
    assert.ok(!cli.command[0].includes(join('@openai', 'codex-sdk')));
  } finally {
    rmSync(depsBase, { recursive: true, force: true });
  }
});

test('an empty dependency directory reports the CLI unresolved', () => {
  const depsBase = makeDepsBase();
  try {
    assert.equal(isCodexSdkAvailable(depsBase), false);
    const cli = getCodexCliStatus(depsBase);
    assert.equal(cli.status, 'unresolved');
    assert.match(cli.reason, /Provider Management > CLI/);
  } finally {
    rmSync(depsBase, { recursive: true, force: true });
  }
});

test('Codex no longer has a managed SDK version', () => {
  assert.equal(getInstalledSdkVersion('codex-sdk'), null);
});
