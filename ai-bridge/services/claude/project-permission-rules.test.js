import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectHasAutoApproveRules } from './project-permission-rules.js';

const created = [];

function makeProject(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-project-rules-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, '.claude', ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

after(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

test('a project without Claude settings defines no auto-approve rules', () => {
  assert.equal(projectHasAutoApproveRules(makeProject()), false);
});

test('settings that only restrict or configure unrelated things are not auto-approve rules', () => {
  const dir = makeProject({
    'settings.json': {
      model: 'sonnet',
      env: { FOO: 'bar' },
      permissions: { deny: ['Read(./.env)'], ask: ['Bash(git push:*)'], allow: [] },
      hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'prettier --write' }] }] },
    },
  });
  assert.equal(projectHasAutoApproveRules(dir), false);
});

test('a project allow rule is an auto-approve rule', () => {
  const dir = makeProject({ 'settings.json': { permissions: { allow: ['Bash(git status:*)'] } } });
  assert.equal(projectHasAutoApproveRules(dir), true);
});

test('a local allow rule is an auto-approve rule', () => {
  const dir = makeProject({ 'settings.local.json': { permissions: { allow: ['Bash(npm test)'] } } });
  assert.equal(projectHasAutoApproveRules(dir), true);
});

test('the legacy allowedTools list is an auto-approve rule', () => {
  const dir = makeProject({ 'settings.json': { allowedTools: ['Bash(ls:*)'] } });
  assert.equal(projectHasAutoApproveRules(dir), true);
});

test('a permissive default mode in project settings is an auto-approve rule', () => {
  for (const defaultMode of ['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk']) {
    const dir = makeProject({ 'settings.json': { permissions: { defaultMode } } });
    assert.equal(projectHasAutoApproveRules(dir), true, defaultMode);
  }
  for (const defaultMode of ['default', 'plan']) {
    const dir = makeProject({ 'settings.json': { permissions: { defaultMode } } });
    assert.equal(projectHasAutoApproveRules(dir), false, defaultMode);
  }
});

test('a project PreToolUse hook can approve tools and counts as an auto-approve rule', () => {
  const dir = makeProject({
    'settings.json': { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'allow.sh' }] }] } },
  });
  assert.equal(projectHasAutoApproveRules(dir), true);
});

test('an enabled project sandbox auto-allows sandboxed commands and counts as an auto-approve rule', () => {
  assert.equal(projectHasAutoApproveRules(makeProject({ 'settings.json': { sandbox: { enabled: true } } })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'settings.local.json': { sandbox: { enabled: true } } })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'settings.json': { sandbox: {} } })), false);
});

test('a project agent that sets its own permission mode counts as an auto-approve rule', () => {
  const granting = makeProject({ 'agents/reviewer.md': '---\nname: reviewer\npermissionMode: acceptEdits\n---\nReview code.\n' });
  assert.equal(projectHasAutoApproveRules(granting), true);
  const plain = makeProject({ 'agents/reviewer.md': '---\nname: reviewer\ntools: Read, Grep\n---\nReview code.\n' });
  assert.equal(projectHasAutoApproveRules(plain), false);
});

test('a project skill or command that pre-approves tools counts as an auto-approve rule', () => {
  assert.equal(projectHasAutoApproveRules(makeProject({ 'skills/cleanup/SKILL.md': '---\nname: cleanup\nallowed-tools: Bash\n---\n' })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'skills/cleanup/SKILL.md': '---\nallowed_tools: Bash\n---\n' })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'commands/deploy.md': '---\nallowed-tools: Bash(git push:*)\n---\n' })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'commands/ops/deploy.md': '---\nallowed-tools: Bash\n---\n' })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'skills/cleanup/SKILL.md': '---\nname: cleanup\ndescription: tidy\n---\n' })), false);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'skills/cleanup/notes.txt': 'allowed-tools: Bash\n' })), false);
});

test('a skill directory reached through a link is scanned too', (t) => {
  const outside = makeProject({ 'skills/real/SKILL.md': '---\nallowed-tools: Bash\n---\n' });
  const dir = makeProject();
  fs.mkdirSync(path.join(dir, '.claude', 'skills'), { recursive: true });
  try {
    fs.symlinkSync(path.join(outside, '.claude', 'skills', 'real'), path.join(dir, '.claude', 'skills', 'linked'), 'junction');
  } catch {
    t.skip('this filesystem cannot create directory links');
    return;
  }
  assert.equal(projectHasAutoApproveRules(dir), true);
});

test('a link loop under the project settings ends the scan', (t) => {
  const dir = makeProject({ 'skills/a/SKILL.md': '---\nname: a\n---\n' });
  try {
    fs.symlinkSync(path.join(dir, '.claude', 'skills'), path.join(dir, '.claude', 'skills', 'a', 'loop'), 'junction');
  } catch {
    t.skip('this filesystem cannot create directory links');
    return;
  }
  assert.equal(projectHasAutoApproveRules(dir), false);
});

test('skill trees too deep or too large to scan are not trusted', () => {
  const deep = makeProject();
  let nested = path.join(deep, '.claude', 'skills');
  for (let level = 0; level < 12; level += 1) nested = path.join(nested, `level${level}`);
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'SKILL.md'), '---\nname: deep\n---\n');
  assert.equal(projectHasAutoApproveRules(deep), true);

  const large = makeProject();
  const skills = path.join(large, '.claude', 'skills', 'many');
  fs.mkdirSync(skills, { recursive: true });
  for (let index = 0; index < 2100; index += 1) fs.writeFileSync(path.join(skills, `note${index}.txt`), '');
  assert.equal(projectHasAutoApproveRules(large), true);
});

test('settings that cannot be read or parsed are not trusted', () => {
  assert.equal(projectHasAutoApproveRules(makeProject({ 'settings.json': '{ not json' })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'settings.local.json': '' })), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'settings.json': '[]' })), true);
});

test('an unknown working directory is not trusted', () => {
  assert.equal(projectHasAutoApproveRules(''), true);
  assert.equal(projectHasAutoApproveRules(undefined), true);
});

test('a missing working directory has no project rules to read', () => {
  assert.equal(projectHasAutoApproveRules(path.join(os.tmpdir(), 'cc-gui-does-not-exist-' + Date.now())), false);
});

test('the user configuration directory is never read as project settings', () => {
  const dir = makeProject({ 'settings.json': { permissions: { allow: ['Bash(echo:*)'] } } });
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
  try {
    assert.equal(projectHasAutoApproveRules(dir), false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});
