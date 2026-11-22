import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTrustFor, settingSourcesFor } from './project-trust.js';

test('a trusted project loads user, project and local settings', () => {
  assert.deepEqual(settingSourcesFor(true), ['user', 'project', 'local']);
});

test('an untrusted project loads user settings only', () => {
  assert.deepEqual(settingSourcesFor(false), ['user']);
});

test('a missing or malformed trust flag is treated as untrusted', () => {
  for (const value of [undefined, null, 'true', 1, {}]) {
    assert.deepEqual(settingSourcesFor(value), ['user'], String(value));
  }
});

test('each call returns a fresh array', () => {
  const first = settingSourcesFor(true);
  first.push('extra');
  assert.deepEqual(settingSourcesFor(true), ['user', 'project', 'local']);
});

test('trust covers the directory the bridge runs in when it is the checked cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-trust-'));
  try {
    assert.equal(projectTrustFor(true, dir, path.resolve(dir)), true);
    assert.equal(projectTrustFor(true, `  ${dir}  `, path.resolve(dir)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an untrusted or malformed flag stays untrusted in the checked cwd', () => {
  const dir = path.resolve(os.tmpdir());
  for (const value of [false, undefined, null, 'true', 1]) {
    assert.equal(projectTrustFor(value, dir, dir), false, String(value));
  }
});

test('a directory the bridge fell back to was never checked and stays untrusted', () => {
  const home = path.resolve(os.homedir());
  assert.equal(projectTrustFor(true, 'C:\\work\\project', home), false);
  assert.equal(projectTrustFor(true, path.join(home, 'missing-project'), home), false);
});

test('a blank cwd stays untrusted whatever directory the bridge picked', () => {
  const home = path.resolve(os.homedir());
  for (const cwd of [undefined, null, '', '   ', 'undefined', 'null', 42]) {
    assert.equal(projectTrustFor(true, cwd, home), false, String(cwd));
  }
  assert.equal(projectTrustFor(true, home, null), false);
});
