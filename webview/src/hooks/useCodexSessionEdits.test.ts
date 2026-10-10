import { act, renderHook } from '@testing-library/react';
import { useCodexSessionEdits } from './useCodexSessionEdits';
import { sendToJava } from '../utils/bridge';
import type { ClaudeMessage } from '../types';

vi.mock('../utils/bridge', () => ({ sendToJava: vi.fn() }));
const edit = (id: string, path: string): ClaudeMessage => ({ type: 'assistant', raw: {
  type: 'assistant', codexThreadId: 'session-a', codexTurnId: id, message: { content: [{ type: 'tool_use', id, name: 'file_change',
    input: { status: 'completed', changes: [{ path, kind: 'add', diff: '+created' }] } }] },
} });
const request = () => vi.mocked(sendToJava).mock.calls.at(-1)![1] as { requestId: string };
const deliver = (requestId: string, threadId: string, messages: ClaudeMessage[]) => act(() => {
  window.dispatchEvent(new CustomEvent('codex-native-data', { detail: { requestType: 'codex_native_read_thread',
    requestId, thread: { id: threadId }, fileChangeMessages: messages.map(message => message.raw) } }));
});

describe('whole-session Codex edits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retains edits before the loaded page, deduplicates live snapshots and refreshes after a turn', () => {
    const recent = edit('recent', '/recent.ts');
    const { result, rerender } = renderHook(props => useCodexSessionEdits(...props), {
      initialProps: ['codex', 'session-a', [recent], false] as [string, string, ClaudeMessage[], boolean],
    });
    expect(sendToJava).toHaveBeenCalledWith('codex_native_read_thread', expect.objectContaining({
      threadId: 'session-a', params: { includeTurns: true, fileChangesOnly: true },
    }));
    deliver(request().requestId, 'session-a', [edit('old', '/old.ts'), recent]);
    expect(result.current).toHaveLength(2);
    rerender(['codex', 'session-a', [recent, edit('next', '/next.ts')], true]);
    expect(result.current).toHaveLength(3);
    expect(sendToJava).toHaveBeenCalledTimes(1);
    rerender(['codex', 'session-a', [recent], false]);
    expect(sendToJava).toHaveBeenCalledTimes(2);
  });

  it('rejects late responses from another session and leaves Claude unchanged', () => {
    const visible = [edit('recent', '/recent.ts')];
    const { result, rerender } = renderHook(props => useCodexSessionEdits(...props), {
      initialProps: ['codex', 'session-a', visible, false] as [string, string, ClaudeMessage[], boolean],
    });
    const oldRequest = request().requestId;
    rerender(['codex', 'session-b', [], false]);
    deliver(oldRequest, 'session-a', [edit('old', '/old.ts')]);
    expect(result.current).toHaveLength(0);
    deliver(request().requestId, 'session-a', [edit('wrong', '/wrong.ts')]);
    expect(result.current).toHaveLength(0);
    rerender(['claude', 'session-a', visible, false]);
    expect(result.current).toBe(visible);
  });

  it('retains legacy patch tools and their outcomes when the native ledger lacks them', () => {
    const fallback: ClaudeMessage[] = [
      { type: 'assistant', raw: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'legacy-patch',
        name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Add File: /legacy.ts\n+created\n*** End Patch' } }] } } },
      { type: 'user', raw: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'legacy-patch',
        content: 'Success', is_error: false }] } } },
    ];
    const { result } = renderHook(() => useCodexSessionEdits('codex', 'session-a', fallback, false));
    deliver(request().requestId, 'session-a', [edit('native', '/native.ts')]);
    expect(result.current).toContain(fallback[0]);
    expect(result.current).toContain(fallback[1]);
    expect(result.current).toHaveLength(3);
  });

  it('keeps visible legacy and native edits in their operation order when older edits are added', () => {
    const legacy: ClaudeMessage = { type: 'assistant', raw: { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'legacy', name: 'apply_patch', input: { patch: '*** Begin Patch\n*** Update File: /same.ts\n@@\n-a\n+b\n*** End Patch' } },
    ] } } };
    const recent = edit('recent', '/same.ts');
    const { result } = renderHook(() => useCodexSessionEdits('codex', 'session-a', [legacy, recent], false));
    deliver(request().requestId, 'session-a', [edit('older', '/older.ts'), recent]);
    expect(result.current.flatMap(message => {
      const blocks = typeof message.raw === 'object' ? message.raw.message?.content : undefined;
      return Array.isArray(blocks) ? blocks.map(block => block.type === 'tool_use' ? block.id : '') : [];
    }))
      .toEqual(['older', 'legacy', 'recent']);
  });
});
