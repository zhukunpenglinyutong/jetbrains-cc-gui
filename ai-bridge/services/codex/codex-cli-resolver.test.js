import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveCodexCli,
  resolveManagedCodexCli,
  targetTripleFor,
  vendorBinaryCandidates,
} from './codex-cli-resolver.js';

const TRIPLE = 'x86_64-pc-windows-msvc';

function makeDepsRoot() {
  return mkdtempSync(join(tmpdir(), 'codex-resolver-'));
}

function writePackageJson(dir, version = '0.111.0') {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex', version }), 'utf8');
}

function installNewLayout(depsRoot, options = {}) {
  // Official layout: vendor/<triple>/codex/codex.exe inside the platform
  // package, nested under the main package.
  const mainPkg = join(depsRoot, '@openai', 'codex');
  writePackageJson(mainPkg, options.version);
  const platformPkg = join(mainPkg, 'node_modules', '@openai', 'codex-win32-x64');
  const binaryDir = join(platformPkg, 'vendor', TRIPLE, 'codex');
  mkdirSync(binaryDir, { recursive: true });
  writeFileSync(join(binaryDir, 'codex.exe'), 'binary', 'utf8');
  return mainPkg;
}

function installLegacyLayout(depsRoot) {
  // Legacy codex-sdk install: the CLI is hoisted and the platform package
  // keeps the historical vendor/<triple>/bin layout.
  const mainPkg = join(depsRoot, '@openai', 'codex');
  writePackageJson(mainPkg, '0.145.0');
  const platformPkg = join(depsRoot, '@openai', 'codex-win32-x64');
  const binaryDir = join(platformPkg, 'vendor', TRIPLE, 'bin');
  mkdirSync(binaryDir, { recursive: true });
  writeFileSync(join(binaryDir, 'codex.exe'), 'binary', 'utf8');
  return mainPkg;
}

test('targetTripleFor maps known platform/arch pairs and rejects others', () => {
  assert.equal(targetTripleFor('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(targetTripleFor('linux', 'arm64'), 'aarch64-unknown-linux-musl');
  assert.equal(targetTripleFor('sunos', 'x64'), null);
});

test('vendorBinaryCandidates covers new, flat and bin layouts', () => {
  const candidates = vendorBinaryCandidates('/vendor-root', TRIPLE, 'win32');
  assert.deepEqual(candidates, [
    join('/vendor-root', TRIPLE, 'codex', 'codex.exe'),
    join('/vendor-root', TRIPLE, 'codex.exe'),
    join('/vendor-root', TRIPLE, 'bin', 'codex.exe'),
  ]);
});

test('resolves the official nested platform-package layout', () => {
  const depsRoot = makeDepsRoot();
  try {
    const mainPkg = installNewLayout(depsRoot);
    const result = resolveManagedCodexCli(depsRoot, {
      platform: 'win32',
      arch: 'x64',
    });
    assert.equal(result.kind, 'native-binary');
    assert.equal(result.packageDir, mainPkg);
    assert.equal(result.version, '0.111.0');
    assert.equal(result.command.length, 1);
    assert.ok(existsSync(result.command[0]));
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('resolves the legacy codex-sdk layout with bin/ vendor path', () => {
  const depsRoot = makeDepsRoot();
  try {
    installLegacyLayout(depsRoot);
    const result = resolveManagedCodexCli(depsRoot, { platform: 'win32', arch: 'x64' });
    assert.equal(result.kind, 'native-binary');
    assert.equal(result.version, '0.145.0');
    assert.ok(result.command[0].endsWith(join('bin', 'codex.exe')));
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('directories named after launch files cannot masquerade as a managed CLI', () => {
  const depsRoot = makeDepsRoot();
  try {
    const mainPkg = join(depsRoot, '@openai', 'codex');
    writePackageJson(mainPkg);
    mkdirSync(join(mainPkg, 'vendor', TRIPLE, 'codex', 'codex.exe'), { recursive: true });
    mkdirSync(join(mainPkg, 'bin', 'codex.js'), { recursive: true });
    assert.equal(resolveManagedCodexCli(depsRoot, { platform: 'win32', arch: 'x64' }), null);
  } finally { rmSync(depsRoot, { recursive: true, force: true }); }
});

test('falls back to the node launcher when the platform package is missing', () => {
  const depsRoot = makeDepsRoot();
  try {
    const mainPkg = join(depsRoot, '@openai', 'codex');
    writePackageJson(mainPkg);
    mkdirSync(join(mainPkg, 'bin'), { recursive: true });
    writeFileSync(join(mainPkg, 'bin', 'codex.js'), '// launcher', 'utf8');
    const result = resolveManagedCodexCli(depsRoot, { platform: 'win32', arch: 'x64' });
    assert.equal(result.kind, 'node-launcher');
    assert.deepEqual(result.command, ['node', join(mainPkg, 'bin', 'codex.js')]);
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('legacy sdk install reuses the CLI nested under @openai/codex-sdk', () => {
  const depsRoot = makeDepsRoot();
  try {
    const nestedPkg = join(
      depsRoot, '@openai', 'codex-sdk', 'node_modules', '@openai', 'codex');
    writePackageJson(nestedPkg, '0.145.0');
    const platformPkg = join(
      depsRoot, '@openai', 'codex-sdk', 'node_modules', '@openai', 'codex-win32-x64');
    const binaryDir = join(platformPkg, 'vendor', TRIPLE, 'codex');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'codex.exe'), 'binary', 'utf8');

    const result = resolveManagedCodexCli(depsRoot, { platform: 'win32', arch: 'x64' });
    assert.equal(result.packageDir, nestedPkg);
    assert.equal(result.kind, 'native-binary');
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('reports unresolved when the platform package is missing entirely', () => {
  const depsRoot = makeDepsRoot();
  try {
    const mainPkg = join(depsRoot, '@openai', 'codex');
    writePackageJson(mainPkg);
    const result = resolveManagedCodexCli(depsRoot, { platform: 'win32', arch: 'x64' });
    assert.equal(result, null);
    const outer = resolveCodexCli({ depsRoot, platform: 'win32', arch: 'x64', discoverCli: () => null, env: {} });
    assert.equal(outer.status, 'unresolved');
    assert.match(outer.reason, /Provider Management > CLI/);
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('explicit external path wins over the managed dependency', () => {
  const depsRoot = makeDepsRoot();
  try {
    installNewLayout(depsRoot);
    const external = join(depsRoot, 'my codex dir', 'codex.exe');
    mkdirSync(join(depsRoot, 'my codex dir'), { recursive: true });
    writeFileSync(external, 'binary', 'utf8');
    const result = resolveCodexCli({
      explicitPath: external,
      depsRoot,
      platform: 'win32',
      arch: 'x64',
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.source, 'explicit');
    assert.deepEqual(result.command, [external]);
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('explicit path with spaces resolves without a shell', () => {
  const depsRoot = makeDepsRoot();
  try {
    const external = join(depsRoot, 'Program Dir With Spaces', 'codex.exe');
    mkdirSync(join(depsRoot, 'Program Dir With Spaces'), { recursive: true });
    writeFileSync(external, 'binary', 'utf8');
    const result = resolveCodexCli({
      explicitPath: external,
      platform: 'win32',
      arch: 'x64',
    });
    assert.equal(result.status, 'resolved');
    assert.equal(result.command[0], external);
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('windows path casing differences do not break managed resolution', { skip: process.platform !== 'win32' }, () => {
  const depsRoot = makeDepsRoot();
  try {
    // Build the tree with unusual casing; NTFS lookups are case-insensitive
    // so the resolver must still find the binary through the canonical names.
    const oddRoot = join(depsRoot, 'OPENAI');
    mkdirSync(oddRoot, { recursive: true });
    // Rename casing of the root itself after creation.
    const canonicalRoot = join(depsRoot, '@openai');
    const mainPkg = join(canonicalRoot, 'CODEX');
    mkdirSync(join(canonicalRoot, 'codex'), { recursive: true });
    writeFileSync(join(mainPkg, 'package.json'), '{"name":"@openai/codex","version":"0.111.0"}', 'utf8');
    const binaryDir = join(mainPkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'codex');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'CODEX.EXE'), 'binary', 'utf8');
    // Sanity: a case-insensitive filesystem resolves the canonical name.
    if (existsSync(join(binaryDir, 'codex.exe'))) {
      const result = resolveManagedCodexCli(depsRoot, { platform: 'win32', arch: 'x64' });
      assert.equal(result.kind, 'native-binary');
    }
  } finally {
    rmSync(depsRoot, { recursive: true, force: true });
  }
});

test('unmanaged explicit path pointing nowhere is reported unresolved', () => {
  const result = resolveCodexCli({
    explicitPath: 'Z:/definitely/missing/codex.exe',
    platform: 'win32',
    arch: 'x64',
  });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.source, 'explicit');
  assert.match(result.reason, /does not exist/);
});

test('external CLI discovery wins over a reusable old installation without writing markers', () => {
  const root = makeDepsRoot();
  try {
    installNewLayout(root);
    const external = join(root, 'external codex.cmd');
    writeFileSync(external, 'fixture', 'utf8');
    const result = resolveCodexCli({ depsRoot: root, env: {}, discoverCli: () => external });
    assert.equal(result.source, 'external');
    assert.deepEqual(result.command, [external]);
    assert.equal(existsSync(join(root, '.installed')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('environment override is authoritative and an invalid override never selects another CLI', () => {
  const result = resolveCodexCli({ env: { CODEX_CLI_PATH: 'Z:/missing/codex.exe' },
    discoverCli: () => { throw new Error('Must not run discovery'); } });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.source, 'explicit');
});


/** A global npm install of @openai/codex with the platform package missing. */
function installBrokenLauncher(root, { triple = TRIPLE, platform = 'win32' } = {}) {
  const pkg = join(root, 'lib', 'node_modules', '@openai', 'codex');
  writePackageJson(pkg, '0.130.0');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', 'utf8');
  // The platform package directory exists but holds no binary, exactly like a
  // partially synced registry or a half-removed global install.
  mkdirSync(join(pkg, 'node_modules', '@openai', `codex-${platform === 'win32' ? 'win32' : 'linux'}-x64`,
    'vendor', triple), { recursive: true });
  return join(pkg, 'bin', 'codex.js');
}

test('a launcher without its platform binary is rejected instead of shadowing a working install', () => {
  const root = makeDepsRoot();
  try {
    const broken = installBrokenLauncher(root);
    const working = join(root, 'manual', 'codex.exe');
    mkdirSync(join(root, 'manual'), { recursive: true });
    writeFileSync(working, 'fixture', 'utf8');
    const result = resolveCodexCli({
      platform: 'win32',
      arch: 'x64',
      env: {},
      discoverCli: () => broken,
      discoverCliCandidates: () => [broken, working],
    });
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.command, [working]);
    // The unconfirmed install keeps a demoted slot: it is never preferred, but
    // also never removed from a user whose layout this heuristic cannot model.
    assert.deepEqual(result.candidates.map((entry) => entry.command[0]), [working, broken]);
    assert.equal(result.candidates[0].suspect, undefined);
    assert.equal(result.candidates[1].suspect, true);
    assert.match(result.candidates[1].reason, /platform binary/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a launcher whose platform binary is present stays the preferred candidate', () => {
  const root = makeDepsRoot();
  try {
    const mainPkg = join(root, '@openai', 'codex');
    writePackageJson(mainPkg);
    mkdirSync(join(mainPkg, 'bin'), { recursive: true });
    writeFileSync(join(mainPkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n', 'utf8');
    const binaryDir = join(mainPkg, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', TRIPLE, 'codex');
    mkdirSync(binaryDir, { recursive: true });
    writeFileSync(join(binaryDir, 'codex.exe'), 'fixture', 'utf8');
    const launcher = join(mainPkg, 'bin', 'codex.js');
    const later = join(root, 'later', 'codex.exe');
    mkdirSync(join(root, 'later'), { recursive: true });
    writeFileSync(later, 'fixture', 'utf8');
    const result = resolveCodexCli({ platform: 'win32', arch: 'x64', env: {},
      discoverCliCandidates: () => [launcher, later] });
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.command, [launcher]);
    assert.deepEqual(result.candidates.map((entry) => entry.command[0]), [launcher, later]);
    assert.deepEqual(result.rejected, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a lone unconfirmed launcher still resolves as a demoted candidate', () => {
  const root = makeDepsRoot();
  try {
    const broken = installBrokenLauncher(root);
    const result = resolveCodexCli({ platform: 'win32', arch: 'x64', env: {},
      discoverCliCandidates: () => [broken] });
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.command, [broken]);
    assert.equal(result.candidates[0].suspect, true);
    assert.match(result.candidates[0].reason, /platform binary/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unresolved discovery reports candidates that cannot be a CLI at all', () => {
  const root = makeDepsRoot();
  try {
    const missing = join(root, 'gone', 'codex.exe');
    const result = resolveCodexCli({ platform: 'win32', arch: 'x64', env: {},
      discoverCliCandidates: () => [missing] });
    assert.equal(result.status, 'unresolved');
    assert.match(result.reason, /Provider Management > CLI/);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /not a file|does not exist/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an SDK metadata directory alone is unavailable while an original SDK vendor binary remains reusable', () => {
  const root = makeDepsRoot();
  try {
    const sdk = join(root, '@openai', 'codex-sdk');
    writePackageJson(sdk, 'sdk-version');
    const options = { depsRoot: root, platform: 'win32', arch: 'x64', env: {}, discoverCli: () => null };
    assert.equal(resolveCodexCli(options).status, 'unresolved');
    const dir = join(sdk, 'vendor', TRIPLE, 'codex');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codex.exe'), 'fixture', 'utf8');
    assert.equal(resolveCodexCli(options).source, 'legacy');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
