import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isKnownStaticSkill, projectHasAutoApproveRules } from './project-permission-rules.js';

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
  for (const defaultMode of ['bypassPermissions', 'acceptEdits', 'auto']) {
    const dir = makeProject({ 'settings.json': { permissions: { defaultMode } } });
    assert.equal(projectHasAutoApproveRules(dir), true, defaultMode);
  }
  for (const defaultMode of ['default', 'plan', 'dontAsk']) {
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

test('a sandbox that is switched off or does not auto-allow Bash is not an auto-approve rule', () => {
  assert.equal(projectHasAutoApproveRules(makeProject({ 'settings.json': { sandbox: { enabled: false } } })), false);
  assert.equal(projectHasAutoApproveRules(makeProject({
    'settings.json': { sandbox: { enabled: true, autoAllowBashIfSandboxed: false } },
  })), false);
});

test('project sandbox options without an explicit switch can widen a sandbox the user enabled', () => {
  const dir = makeProject({ 'settings.json': { sandbox: { filesystem: { allowWrite: ['~'] } } } });
  assert.equal(projectHasAutoApproveRules(dir), true);
});

test('settings files too large to read within the limit are not trusted', () => {
  const dir = makeProject({ 'settings.json': JSON.stringify({ model: 'sonnet', padding: 'x'.repeat(1024 * 1024 + 1) }) });
  assert.equal(projectHasAutoApproveRules(dir), true);
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

const DEFINITION_FILES = {
  agent: 'agents/worker.md',
  skill: 'skills/cleanup/SKILL.md',
  command: 'commands/deploy.md',
};

function definitionGrants(file, frontmatter, body = 'Do the work.\n') {
  return projectHasAutoApproveRules(makeProject({ [file]: `---\n${frontmatter}\n---\n${body}` }));
}

test('quoted, indented and otherwise valid YAML forms of a granting key are detected in every definition type', () => {
  const forms = {
    'double-quoted key': 'name: x\ndescription: test\n"allowed-tools": Bash',
    'single-quoted key': "name: x\ndescription: test\n'allowed-tools': Bash",
    'escaped key': 'name: x\n"allowed\\x2dtools": Bash',
    'indented mapping': '  name: x\n  description: test\n  allowed-tools: Bash',
    'explicit key': 'name: x\n? allowed-tools\n: Bash',
    'flow mapping': '{name: x, allowed-tools: Bash}',
    'camel-case key': 'name: x\nallowedTools: Bash',
    'upper-case key': 'name: x\nALLOWED_TOOLS: Bash',
    'list value': 'name: x\nallowed-tools:\n  - Bash\n  - Edit',
    'merged key': 'name: x\nbase: &grant {allowed-tools: Bash}\n<<: *grant',
    'quoted permission mode': 'name: x\n"permissionMode": acceptEdits',
    'snake-case permission mode': 'name: x\npermission_mode: acceptEdits',
    'CRLF line endings': 'name: x\r\n"allowed-tools": Bash\r',
  };
  for (const [type, file] of Object.entries(DEFINITION_FILES)) {
    for (const [form, frontmatter] of Object.entries(forms)) {
      assert.equal(definitionGrants(file, frontmatter), true, `${type}: ${form}`);
    }
  }
});

test('a granting key after the first 64 KiB of the frontmatter is not missed', () => {
  const padding = 'x'.repeat(66 * 1024);
  for (const [type, file] of Object.entries(DEFINITION_FILES)) {
    assert.equal(definitionGrants(file, `name: x\ndescription: test\npadding: ${padding}\nallowed-tools: Bash`), true, type);
    assert.equal(definitionGrants(file, `name: x\ndescription: test\npadding: ${padding}\npermissionMode: acceptEdits`), true, type);
  }
});

test('a frontmatter still open after the read limit is not trusted', () => {
  const padding = 'x'.repeat(66 * 1024);
  assert.equal(definitionGrants(DEFINITION_FILES.skill, `name: x\npadding: ${padding}`), true);
});

test('a long body after a short frontmatter is not read as frontmatter', () => {
  const body = `${'Long instructions.\n'.repeat(5000)}allowed-tools: Bash\n`;
  assert.equal(definitionGrants(DEFINITION_FILES.skill, 'name: x\ndescription: test', body), false);
});

test('restrictive frontmatter values do not approve anything', () => {
  for (const mode of ['default', 'plan', 'dontAsk']) {
    assert.equal(definitionGrants(DEFINITION_FILES.agent, `name: x\npermissionMode: ${mode}`), false, mode);
  }
  for (const mode of ['acceptEdits', 'bypassPermissions', 'auto']) {
    assert.equal(definitionGrants(DEFINITION_FILES.agent, `name: x\npermissionMode: ${mode}`), true, mode);
  }
  for (const value of ['[]', '""', '']) {
    assert.equal(definitionGrants(DEFINITION_FILES.skill, `name: x\nallowed-tools: ${value}`), false, `allowed-tools: ${value}`);
    assert.equal(definitionGrants(DEFINITION_FILES.command, `name: x\nallowed-tools: ${value}`), false, `allowed-tools: ${value}`);
  }
  assert.equal(definitionGrants(DEFINITION_FILES.skill, 'name: x\ndisallowed-tools: Bash'), false);
});

test('a granting key in the Markdown body grants nothing', () => {
  assert.equal(definitionGrants(DEFINITION_FILES.skill, 'name: x\ndescription: test', 'Example:\n\nallowed-tools: Bash\n'), false);
  assert.equal(definitionGrants(DEFINITION_FILES.agent, 'name: x', 'Never set\npermissionMode: acceptEdits\n'), false);
  assert.equal(projectHasAutoApproveRules(makeProject({ [DEFINITION_FILES.skill]: '# Notes\n\nallowed-tools: Bash\n' })), false);
});

test('a value containing --- cannot hide the keys after it', () => {
  assert.equal(definitionGrants(DEFINITION_FILES.skill, 'name: x\ndescription: split---here\nallowed-tools: Bash'), true);
});

test('a frontmatter PreToolUse hook counts as an auto-approve rule', () => {
  const preToolUse = 'name: x\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: allow.sh';
  const postToolUse = 'name: x\nhooks:\n  PostToolUse:\n    - matcher: Edit\n      hooks:\n        - type: command\n          command: prettier';
  for (const [type, file] of Object.entries(DEFINITION_FILES)) {
    assert.equal(definitionGrants(file, preToolUse), true, type);
    assert.equal(definitionGrants(file, postToolUse), false, type);
  }
});

test('frontmatter that mentions a granting key but is not valid YAML is not trusted', () => {
  assert.equal(definitionGrants(DEFINITION_FILES.skill, '"allowed-tools": Bash\ndescription: "unterminated'), true);
  assert.equal(definitionGrants(DEFINITION_FILES.agent, 'name: x\n\tpermissionMode: acceptEdits'), true);
});

test('a duplicated granting key counts with each of its values', () => {
  assert.equal(definitionGrants(DEFINITION_FILES.skill, 'name: x\nallowed-tools: Bash\nallowed-tools: []'), true);
  assert.equal(definitionGrants(DEFINITION_FILES.skill, 'name: x\nallowed-tools: []\nallowed-tools: Bash'), true);
  assert.equal(definitionGrants(DEFINITION_FILES.skill, 'name: x\nallowed-tools: []\nallowed_tools: Bash'), true);
});

test('frontmatter scanning stays fast on long runs of blank lines', () => {
  const files = {};
  for (let index = 0; index < 20; index += 1) {
    files[`skills/open${index}/SKILL.md`] = `---${'\n'.repeat(60 * 1024)}`;
    files[`skills/closed${index}/SKILL.md`] = `---${'\n'.repeat(30 * 1024)}name: x\n---\n`;
  }
  const dir = makeProject(files);
  const started = performance.now();
  assert.equal(projectHasAutoApproveRules(dir), false);
  assert.ok(performance.now() - started < 1000, 'scan took too long');
});

test('frontmatter scanning stays fast when every block mentions a granting key', () => {
  const files = {};
  const keys = Array.from({ length: 1500 }, (_, index) => `k${index}: v`).join('\n');
  for (let index = 0; index < 60; index += 1) {
    files[`skills/s${index}/SKILL.md`] = `---\n${keys}\n# hooks\n---\n`;
  }
  const dir = makeProject(files);
  const started = performance.now();
  projectHasAutoApproveRules(dir);
  assert.ok(performance.now() - started < 1000, 'scan took too long');
});

test('frontmatter too large to parse within the limits is not trusted', () => {
  const large = `name: x\n# hooks\n${'k: v\n'.repeat(4000)}`;
  assert.equal(definitionGrants(DEFINITION_FILES.skill, large), true);

  const files = {};
  const block = `---\nname: x\ndescription: "C:\\\\tools"\n${'#'.repeat(15 * 1024)}\n---\n`;
  for (let index = 0; index < 20; index += 1) files[`skills/s${index}/SKILL.md`] = block;
  assert.equal(projectHasAutoApproveRules(makeProject(files)), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'skills/s0/SKILL.md': block })), false);
});

test('definition files beyond the total read budget are not trusted', () => {
  const files = {};
  const frontmatter = `---\nname: x\ndescription: ${'x'.repeat(60 * 1024)}\n---\n`;
  for (let index = 0; index < 80; index += 1) files[`skills/s${index}/SKILL.md`] = frontmatter;
  assert.equal(projectHasAutoApproveRules(makeProject(files)), true);
  assert.equal(projectHasAutoApproveRules(makeProject({ 'skills/s0/SKILL.md': frontmatter })), false);
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

test('the user configuration directory reached through a link is never read as project settings', (t) => {
  const config = makeProject({ 'settings.json': { permissions: { allow: ['Bash(echo:*)'] } } });
  const linkedProject = makeProject();
  const linkedConfig = makeProject();
  fs.rmSync(path.join(linkedConfig, '.claude'), { recursive: true, force: true });
  try {
    fs.symlinkSync(path.join(config, '.claude'), path.join(linkedProject, '.claude'), 'junction');
    fs.symlinkSync(path.join(config, '.claude'), path.join(linkedConfig, '.claude'), 'junction');
  } catch {
    t.skip('this filesystem cannot create directory links');
    return;
  }
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(config, '.claude');
    assert.equal(projectHasAutoApproveRules(linkedProject), false);
    process.env.CLAUDE_CONFIG_DIR = path.join(linkedConfig, '.claude');
    assert.equal(projectHasAutoApproveRules(config), false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

function withConfigDir(dir, run) {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

function subdirectory(dir, ...parts) {
  const target = path.join(dir, ...parts);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

test('a granting skill, agent or command in a parent directory of the working directory is detected', () => {
  const skill = makeProject({ 'skills/evil/SKILL.md': '---\nname: evil\nallowed-tools: Bash\n---\n' });
  assert.equal(projectHasAutoApproveRules(subdirectory(skill, 'backend')), true);
  assert.equal(projectHasAutoApproveRules(subdirectory(skill, 'backend', 'src')), true);

  const agent = makeProject({ 'agents/ed.md': '---\nname: ed\npermissionMode: acceptEdits\n---\n' });
  assert.equal(projectHasAutoApproveRules(subdirectory(agent, 'backend')), true);

  const command = makeProject({ 'commands/deploy.md': '---\nallowed-tools: Bash\n---\n' });
  assert.equal(projectHasAutoApproveRules(subdirectory(command, 'backend')), true);
});

test('harmless definitions in a parent directory do not stop the yield', () => {
  const dir = makeProject({ 'skills/tidy/SKILL.md': '---\nname: tidy\ndescription: tidy up\n---\n' });
  assert.equal(projectHasAutoApproveRules(subdirectory(dir, 'backend')), false);
});

test('the user configuration directory among the parents is not read as project configuration', () => {
  const dir = makeProject({ 'skills/mine/SKILL.md': '---\nallowed-tools: Bash\n---\n' });
  const cwd = subdirectory(dir, 'backend');
  assert.equal(withConfigDir(path.join(dir, '.claude'), () => projectHasAutoApproveRules(cwd)), false);
});

test('a startup skill in the working directory, a parent or the user configuration resolves to a scanned definition', () => {
  const dir = makeProject({
    'skills/tidy/SKILL.md': '---\nname: tidy\ndescription: tidy up\n---\n',
    'skills/plain/SKILL.md': 'No frontmatter.\n',
    'commands/ops/deploy.md': '---\ndescription: deploy\n---\n',
  });
  assert.equal(isKnownStaticSkill(dir, 'tidy'), true);
  assert.equal(isKnownStaticSkill(dir, '/tidy'), true);
  assert.equal(isKnownStaticSkill(dir, 'plain'), true);
  assert.equal(isKnownStaticSkill(dir, 'ops:deploy'), true);
  assert.equal(isKnownStaticSkill(subdirectory(dir, 'backend'), 'tidy'), true);

  const config = makeProject({ 'skills/mine/SKILL.md': '---\nname: mine\nallowed-tools: Bash\n---\n' });
  const elsewhere = makeProject();
  assert.equal(withConfigDir(path.join(config, '.claude'), () => isKnownStaticSkill(elsewhere, 'mine')), true);
});

test('a skill that only exists in a subdirectory is not a startup skill', () => {
  const dir = makeProject();
  const sub = subdirectory(dir, 'sub', '.claude', 'skills', 'evil');
  fs.writeFileSync(path.join(sub, 'SKILL.md'), '---\nname: evil\nallowed-tools: Bash\n---\n');
  assert.equal(isKnownStaticSkill(dir, 'evil'), false);
  assert.equal(isKnownStaticSkill(dir, 'sub:evil'), false);
});

test('names that do not resolve exactly to a startup definition are not trusted', () => {
  const dir = makeProject({ 'skills/tidy/SKILL.md': '---\nname: tidy\n---\n' });
  for (const name of ['Tidy', 'TIDY', 'missing', '', '  ', '../tidy', 'tidy/SKILL', 'skills\\tidy', 'a::b', ':tidy', 'plugin:tidy', '.', '..']) {
    assert.equal(isKnownStaticSkill(dir, name), false, JSON.stringify(name));
  }
  assert.equal(isKnownStaticSkill(dir, undefined), false);
  assert.equal(isKnownStaticSkill(dir, 42), false);
  assert.equal(isKnownStaticSkill('', 'tidy'), false);
});

test('a conditional, renamed or unreadable startup skill does not keep its name for itself', () => {
  const dir = makeProject({
    'skills/scoped/SKILL.md': '---\nname: scoped\npaths: ["src/**"]\n---\n',
    'skills/renamed/SKILL.md': '---\nname: other\n---\n',
    'skills/broken/SKILL.md': '---\nname: broken\ndescription: "unterminated\n---\n',
    'skills/merged/SKILL.md': '---\nbase: &b {paths: ["src/**"]}\n<<: *b\n---\n',
    'skills/open/SKILL.md': `---\nname: open\npadding: ${'x'.repeat(66 * 1024)}\n`,
  });
  for (const name of ['scoped', 'renamed', 'broken', 'merged', 'open']) {
    assert.equal(isKnownStaticSkill(dir, name), false, name);
  }
});

test('one unvetted definition of a name in any startup location is enough to distrust it', () => {
  const parent = makeProject({ 'skills/tidy/SKILL.md': '---\nname: tidy\npaths: ["**"]\n---\n' });
  const cwd = subdirectory(parent, 'backend');
  fs.mkdirSync(path.join(cwd, '.claude', 'skills', 'tidy'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\n---\n');
  assert.equal(isKnownStaticSkill(cwd, 'tidy'), false);
});
