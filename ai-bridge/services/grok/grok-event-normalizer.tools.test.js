/**
 * Grok edit-stats ledger + turn-end flush tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GrokEventNormalizer,
  extractPermissionEditInfo,
  hasUsableEditPayload,
  isPermissionMethod,
  normalizeEditToolInput,
  normalizeEditToolName,
} from './grok-event-normalizer.js';

describe('normalize helpers', () => {
  it('maps permission-style write fields', () => {
    const input = normalizeEditToolInput(
      { path: '/tmp/a.txt', content: '122' },
      [],
    );
    assert.equal(input.file_path, '/tmp/a.txt');
    assert.equal(input.new_string, '122');
    assert.equal(hasUsableEditPayload(input), true);
    assert.equal(normalizeEditToolName('', 'edit', 'write'), 'Write');
  });

  it('extracts Edit from session/request_permission params', () => {
    const info = extractPermissionEditInfo({
      toolCall: {
        toolCallId: 'p1',
        title: 'Edit',
        kind: 'edit',
        rawInput: { path: '/proj/122.txt', content: '122' },
      },
    });
    assert.ok(info);
    assert.equal(info.toolCallId, 'p1');
    assert.equal(info.input.file_path, '/proj/122.txt');
  });
});

describe('turn-end flush guarantees final edit stats data', () => {
  it('permission Edit booked mid-turn, flushed as tool_use+result at finishSuccess', () => {
    const lines = [];
    const n = new GrokEventNormalizer({
      log: (line) => lines.push(String(line)),
      error: () => {},
    });
    n.begin();

    // Mid-stream: only permission request (live Grok behaviour)
    n.handleAcpEvent('server_request', {
      method: 'session/request_permission',
      params: {
        toolCall: {
          toolCallId: 'perm-1',
          title: 'Edit',
          kind: 'edit',
          rawInput: {
            path: '/proj/122-2026-08-15-162513.txt',
            content: '122',
          },
        },
      },
    });

    // User allows
    n.handleAcpEvent('permission_decision', {
      allowed: true,
      toolCallId: 'perm-1',
      toolName: 'Edit',
    });

    // Even if mid-stream emit happened, finishSuccess re-settles cleanly
    n.finishSuccess('sess-1', 'done');

    const uses = lines.filter((l) => l.startsWith('[MESSAGE]') && l.includes('tool_use'));
    const results = lines.filter((l) => l.startsWith('[TOOL_RESULT]'));
    assert.ok(uses.length >= 1, 'must emit tool_use');
    assert.ok(results.length >= 1, 'must emit tool_result');
    assert.ok(uses.some((l) => l.includes('122-2026-08-15-162513')));
    assert.ok(uses.some((l) => l.includes('122')));

    // STREAM_END must come after tool settlement
    const idxResult = lines.findIndex((l) => l.startsWith('[TOOL_RESULT]'));
    const idxEnd = lines.findIndex((l) => l.startsWith('[STREAM_END]'));
    assert.ok(idxResult >= 0 && idxEnd > idxResult, 'flush before STREAM_END');
  });

  it('books permission without body and still flushes path-only Write at end', () => {
    const lines = [];
    const n = new GrokEventNormalizer({
      log: (line) => lines.push(String(line)),
      error: () => {},
    });
    n.begin();

    n.handleAcpEvent('server_request', {
      method: 'session/request_permission',
      params: {
        toolCall: {
          toolCallId: 'perm-2',
          kind: 'edit',
          title: 'Edit',
          rawInput: { path: '/proj/empty-ish.txt' },
          locations: [{ path: '/proj/empty-ish.txt' }],
        },
      },
    });
    // No permission_decision mid-stream — finishSuccess still flushes booked path
    n.finishSuccess('sess-2', 'ok');

    const uses = lines.filter((l) => l.startsWith('[MESSAGE]') && l.includes('tool_use'));
    assert.ok(uses.length >= 1);
    assert.ok(uses[0].includes('empty-ish.txt'));
  });

  it('fs_write alone produces Write stats payload before stream end', () => {
    const lines = [];
    const n = new GrokEventNormalizer({
      log: (line) => lines.push(String(line)),
      error: () => {},
    });
    n.begin();
    n.handleAcpEvent('fs_write', { path: '/proj/only-fs.txt', content: 'hi\n' });
    n.finishSuccess('sess-3', 'ok');

    const uses = lines.filter((l) => l.startsWith('[MESSAGE]') && l.includes('tool_use'));
    assert.equal(uses.length, 1);
    assert.match(uses[0], /"name":"Write"/);
    assert.match(uses[0], /only-fs\.txt/);
  });
});

describe('finishError flush settles only edits with execution evidence', () => {
  it('an undecided permission edit is NOT counted as success on the error path', () => {
    const lines = [];
    const n = new GrokEventNormalizer({
      log: (line) => lines.push(String(line)),
      error: () => {},
    });
    n.begin();

    // Permission requested, but the turn fails before the user decides.
    n.handleAcpEvent('server_request', {
      method: 'session/request_permission',
      params: {
        toolCall: {
          toolCallId: 'perm-err-1',
          title: 'Edit',
          kind: 'edit',
          rawInput: { path: '/proj/never-ran.txt', content: 'x' },
        },
      },
    });
    n.finishError(new Error('grok exploded'));

    const results = lines
      .filter((l) => l.startsWith('[TOOL_RESULT]'))
      .map((l) => JSON.parse(l.slice('[TOOL_RESULT] '.length)));
    assert.ok(results.length >= 1, 'the booked edit must still be settled for a complete pair');
    const settled = results.find((r) => r.tool_use_id === 'perm-err-1');
    assert.ok(settled, 'pending permission edit must be settled, not dropped');
    assert.equal(settled.is_error, true,
      'an edit that never ran must not be flushed as a success');
  });

  it('an fs_write-backed edit still counts as completed on the error path', () => {
    const lines = [];
    const n = new GrokEventNormalizer({
      log: (line) => lines.push(String(line)),
      error: () => {},
    });
    n.begin();
    n.handleAcpEvent('fs_write', { path: '/proj/really-wrote.txt', content: 'data' });
    n.finishError(new Error('turn died after the write'));

    const results = lines
      .filter((l) => l.startsWith('[TOOL_RESULT]'))
      .map((l) => JSON.parse(l.slice('[TOOL_RESULT] '.length)));
    assert.equal(results.length, 1);
    assert.equal(results[0].is_error, false,
      'an edit with execution evidence (fs_write) must keep its success settlement');
  });

  it('an explicitly allowed permission edit still counts as completed on the error path', () => {
    const lines = [];
    const n = new GrokEventNormalizer({
      log: (line) => lines.push(String(line)),
      error: () => {},
    });
    n.begin();
    n.handleAcpEvent('server_request', {
      method: 'session/request_permission',
      params: {
        toolCall: {
          toolCallId: 'perm-err-2',
          title: 'Edit',
          kind: 'edit',
          rawInput: { path: '/proj/allowed.txt', content: 'y' },
        },
      },
    });
    n.handleAcpEvent('permission_decision', {
      allowed: true,
      toolCallId: 'perm-err-2',
      toolName: 'Edit',
    });
    n.finishError(new Error('turn died after the user allowed'));

    const results = lines
      .filter((l) => l.startsWith('[TOOL_RESULT]'))
      .map((l) => JSON.parse(l.slice('[TOOL_RESULT] '.length)));
    const settled = results.find((r) => r.tool_use_id === 'perm-err-2');
    assert.ok(settled);
    assert.equal(settled.is_error, false,
      'an explicitly allowed edit has execution intent and stays a success');
  });
});

describe('permission fallback ledger keys', () => {
  it('uses the caller-provided fallback id instead of a Date.now() key', () => {
    const info = extractPermissionEditInfo(
      {
        toolCall: {
          title: 'Edit',
          kind: 'edit',
          rawInput: { path: '/proj/no-id.txt', content: 'z' },
        },
      },
      'perm-edit-7',
    );
    assert.ok(info);
    assert.equal(info.toolCallId, 'perm-edit-7');
  });

  it('booked permission edits without toolCallId get unique seq-based keys', () => {
    const n = new GrokEventNormalizer({ log: () => {}, error: () => {} });
    n.begin();
    const params = () => ({
      method: 'session/request_permission',
      params: {
        toolCall: {
          title: 'Edit',
          kind: 'edit',
          rawInput: { path: '/proj/keyless.txt', content: 'z' },
        },
      },
    });
    // Two permission requests in the same millisecond must not overwrite
    // each other's ledger entries.
    n.handleAcpEvent('server_request', params());
    n.handleAcpEvent('server_request', params());
    const keys = [...n.toolCalls.keys()];
    assert.equal(keys.length, 2, 'keyless permission edits must not collide');
    assert.ok(keys.every((k) => /^perm-edit-\d+$/.test(k)));
    assert.notEqual(keys[0], keys[1]);
  });
});

describe('isPermissionMethod', () => {
  it('matches the ACP permission request methods exactly', () => {
    assert.equal(isPermissionMethod('session/request_permission'), true);
    assert.equal(isPermissionMethod('request_permission'), true);
  });

  it('rejects methods that merely contain the permission substring', () => {
    assert.equal(isPermissionMethod('session/permission_update'), false);
    assert.equal(isPermissionMethod('session/cancel_permission'), false);
    assert.equal(isPermissionMethod('PermissionChanged'), false);
    assert.equal(isPermissionMethod('fs/write_text_file'), false);
    assert.equal(isPermissionMethod(''), false);
    assert.equal(isPermissionMethod(null), false);
  });
});
