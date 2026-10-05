import { act, renderHook } from '@testing-library/react';
import type { RefObject } from 'react';
import { useFileChangesManagement } from './useFileChangesManagement.js';
import type { ClaudeMessage } from '../types';

function makeOptions(sessionId: string | null, messages: ClaudeMessage[] = []) {
  const currentSessionIdRef: RefObject<string | null> = { current: sessionId };
  return {
    currentSessionId: sessionId,
    currentSessionIdRef,
    messages,
    getContentBlocks: () => [],
    findToolResult: () => null,
  };
}

function makeMessages(count = 1): ClaudeMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'assistant',
    timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
  }) as unknown as ClaudeMessage);
}

function readStored(sessionId: string): string[] | null {
  const raw = localStorage.getItem(`confirmed-edits-${sessionId}`);
  return raw ? JSON.parse(raw) : null;
}

describe('useFileChangesManagement > confirmEdits (Keep All)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('acknowledges operations and persists them for the session', () => {
    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-1'),
    });

    act(() => {
      result.current.confirmEdits(['op-a', 'op-b']);
    });

    expect([...result.current.confirmedEditKeys].sort()).toEqual(['op-a', 'op-b']);
    expect(readStored('session-1')?.slice().sort()).toEqual(['op-a', 'op-b']);
  });

  it('accumulates across calls without duplicating', () => {
    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-1'),
    });

    act(() => {
      result.current.confirmEdits(['op-a']);
    });
    act(() => {
      result.current.confirmEdits(['op-a', 'op-b']);
    });

    expect([...result.current.confirmedEditKeys].sort()).toEqual(['op-a', 'op-b']);
    expect(readStored('session-1')?.slice().sort()).toEqual(['op-a', 'op-b']);
  });

  // The reported regression, end to end: Keep All in one session, start a new
  // session, then reopen the first one from history — nothing kept may return.
  it('restores the acknowledgements when the session is reopened', () => {
    const { result: first } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-A'),
    });

    act(() => {
      first.current.confirmEdits(['op-a']);
    });

    const { result: other } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-B'),
    });
    expect(other.current.confirmedEditKeys.size).toBe(0);

    const { result: reopened } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-A'),
    });
    expect([...reopened.current.confirmedEditKeys]).toEqual(['op-a']);
  });

  it('clears the acknowledgements when switching to a session that has none', () => {
    const { result, rerender } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-A'),
    });

    act(() => {
      result.current.confirmEdits(['op-a']);
    });
    expect(result.current.confirmedEditKeys.size).toBe(1);

    rerender(makeOptions('session-B'));

    expect(result.current.confirmedEditKeys.size).toBe(0);
  });

  it('clears the persisted per-file marks along with the acknowledgements', () => {
    // A file the user accepted one by one earlier must not come back after Keep
    // All: on the next load it would hide later edits to that same file, and the
    // list would no longer offer a way to undo it.
    localStorage.setItem('processed-files-session-1', '["/proj/x.ts"]');

    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-1'),
    });
    act(() => {
      result.current.confirmEdits(['op-a']);
    });

    expect(localStorage.getItem('processed-files-session-1')).toBeNull();
    expect(readStored('session-1')).toEqual(['op-a']);
  });

  it('clears the persisted per-file marks even when there is nothing new to acknowledge', () => {
    localStorage.setItem('processed-files-session-1', '["/proj/x.ts"]');

    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-1'),
    });
    act(() => {
      result.current.confirmEdits([]);
    });

    expect(localStorage.getItem('processed-files-session-1')).toBeNull();
  });

  it('flushes the acknowledgements once the session id arrives', () => {
    const messages = makeMessages(2);
    const { result, rerender } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions(null, messages),
    });

    // A brand-new session has no id until the backend reports one.
    act(() => {
      result.current.confirmEdits(['op-a']);
    });
    expect(readStored('session-late')).toBeNull();
    // The in-memory effect is immediate regardless.
    expect(result.current.confirmedEditKeys.size).toBe(1);

    // window.setSessionId updates both the ref and the state; the transcript is
    // left alone, and that is what marks the id as belonging to this session.
    const adopted = makeOptions('session-late', messages);
    adopted.currentSessionIdRef.current = 'session-late';
    rerender(adopted);

    expect(readStored('session-late')).toEqual(['op-a']);
    expect([...result.current.confirmedEditKeys]).toEqual(['op-a']);
  });

  // Switching to another existing session also goes from "no id" to "an id", so
  // a pending acknowledgement must not be flushed onto — and overwrite — that
  // session's own record.
  it('does not flush a pending acknowledgement onto a different session', () => {
    const { result, rerender } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions(null, makeMessages(2)),
    });

    act(() => {
      result.current.confirmEdits(['op-a']);
    });

    // The other session already has its own acknowledgements.
    localStorage.setItem('confirmed-edits-session-B', '["op-b"]');
    // Switching empties the transcript first, so the pending list has nothing
    // to be recognised by and is dropped.
    const switched = makeOptions('session-B');
    switched.currentSessionIdRef.current = 'session-B';
    rerender(switched);

    expect(readStored('session-B')).toEqual(['op-b']);
    expect([...result.current.confirmedEditKeys]).toEqual(['op-b']);
  });

  it('ignores a malformed persisted list', () => {
    localStorage.setItem('confirmed-edits-session-1', '{"not":"a list"}');

    const { result } = renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-1'),
    });

    expect(result.current.confirmedEditKeys.size).toBe(0);
  });

  it('drops superseded position-based baselines from earlier releases', () => {
    localStorage.setItem('keep-all-base-session-1', '3');
    localStorage.setItem('keep-all-anchor-session-1', '{"aliases":[],"index":0}');

    renderHook((props) => useFileChangesManagement(props), {
      initialProps: makeOptions('session-1'),
    });

    expect(localStorage.getItem('keep-all-base-session-1')).toBeNull();
    expect(localStorage.getItem('keep-all-anchor-session-1')).toBeNull();
  });
});
