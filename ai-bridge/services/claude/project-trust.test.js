import test from 'node:test';
import assert from 'node:assert/strict';
import { settingSourcesFor } from './project-trust.js';

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
