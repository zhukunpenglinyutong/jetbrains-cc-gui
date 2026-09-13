import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Approval bridge integration test: simulates the Java PermissionRequestWatcher
 * by answering the file-IPC request the node bridge writes, and asserts the
 * host gets a well-formed /api/respond value.
 *
 * permission-ipc resolves CLAUDE_PERMISSION_DIR / CLAUDE_SESSION_ID at module
 * load, so the env is set before the dynamic imports below.
 */

test('bridgeDshApproval answers allowed-once when the dialog approves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-perm-test-'));
  process.env.CLAUDE_PERMISSION_DIR = dir;
  process.env.CLAUDE_SESSION_ID = 'jest-session';
  try {
    const { bridgeDshApproval } = await import('./events.js');

    const respondCalls = [];
    const fakeClient = {
      respond: async (rpcId, value) => {
        respondCalls.push({ rpcId, value });
      },
    };
    const event = {
      rpcId: 'rpc-42',
      approvalId: 'approval-1',
      toolName: 'bash',
      message: 'wants to run ls',
      input: { command: 'ls' },
    };

    // Fake Java side: watch for the request file, then answer allow:true.
    const responder = setInterval(() => {
      const requestFile = readdirSync(dir).find(
        (name) => name.startsWith('request-jest-session-') && name.endsWith('.json'),
      );
      if (!requestFile) {
        return;
      }
      const request = JSON.parse(readFileSync(join(dir, requestFile), 'utf8'));
      assert.equal(request.toolName, 'bash');
      const requestId = requestFile
        .replace('request-jest-session-', '')
        .replace('.json', '');
      writeFileSync(
        join(dir, `response-jest-session-${requestId}.json`),
        JSON.stringify({ allow: true, requestId }),
      );
    }, 50);

    const ok = await bridgeDshApproval(fakeClient, event, 'session-x');
    clearInterval(responder);

    assert.equal(ok, true);
    assert.equal(respondCalls.length, 1);
    assert.equal(respondCalls[0].rpcId, 'rpc-42');
    assert.deepEqual(respondCalls[0].value, {
      sessionId: 'session-x',
      approvalId: 'approval-1',
      outcome: 'allowed-once',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridgeDshApproval answers rejected when the dialog denies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-perm-test-'));
  process.env.CLAUDE_PERMISSION_DIR = dir;
  process.env.CLAUDE_SESSION_ID = 'jest-session';
  try {
    const { bridgeDshApproval } = await import('./events.js');

    const respondCalls = [];
    const fakeClient = {
      respond: async (rpcId, value) => {
        respondCalls.push({ rpcId, value });
      },
    };
    const event = { rpcId: 'rpc-43', approvalId: 'approval-2', toolName: 'bash' };

    const responder = setInterval(() => {
      const requestFile = readdirSync(dir).find(
        (name) => name.startsWith('request-jest-session-') && name.endsWith('.json'),
      );
      if (!requestFile) {
        return;
      }
      const requestId = requestFile
        .replace('request-jest-session-', '')
        .replace('.json', '');
      writeFileSync(
        join(dir, `response-jest-session-${requestId}.json`),
        JSON.stringify({ allow: false, requestId }),
      );
    }, 50);

    const ok = await bridgeDshApproval(fakeClient, event, 'session-x');
    clearInterval(responder);

    assert.equal(ok, true);
    assert.equal(respondCalls[0].value.outcome, 'rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
