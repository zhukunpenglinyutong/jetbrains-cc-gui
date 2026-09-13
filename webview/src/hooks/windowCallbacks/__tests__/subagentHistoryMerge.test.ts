import { describe, expect, it } from 'vitest';
import {
  isCurrentSubagentResponse,
  mergeSubagentHistory,
  toSubagentHistoryResponse,
} from '../subagentHistoryMerge';

describe('subagentHistoryMerge', () => {
  it('does not let a late running response overwrite a completed status', () => {
    expect(mergeSubagentHistory(
      { success: true, completed: true, status: 'completed' },
      { success: false, completed: false, status: 'running', error: 'not found yet' },
    )).toEqual({
      success: true,
      completed: true,
      status: 'completed',
      error: undefined,
    });
  });

  it('adds a transcript without regressing an existing terminal status', () => {
    expect(mergeSubagentHistory(
      { success: true, completed: true, status: 'completed' },
      { success: true, completed: false, status: 'running', messages: [{ type: 'assistant' }] },
    )).toMatchObject({
      completed: true,
      status: 'completed',
      messages: [{ type: 'assistant' }],
    });
  });

  it('attaches batch session identity to a lightweight snapshot', () => {
    expect(toSubagentHistoryResponse(
      { success: false, toolUseId: 'call-1', status: 'running' },
      { sessionId: 'session-1', provider: 'codex', requestId: 'request-1' },
    )).toEqual({
      success: false,
      toolUseId: 'call-1',
      status: 'running',
      sessionId: 'session-1',
      provider: 'codex',
    });
  });

  it('keeps an authoritatively failed sidechain terminal', () => {
    expect(mergeSubagentHistory(
      { success: true, completed: false, status: 'error', error: 'Codex subagent turn was aborted' },
      { success: false, completed: false, status: 'running', error: 'not found yet' },
    )).toEqual({
      success: true,
      completed: false,
      status: 'error',
      error: 'Codex subagent turn was aborted',
    });
  });

  it('lets a later running snapshot correct a transient resolution error', () => {
    // success === false means the backend never read the sidechain (transient
    // IO / resolution failure), so the error must NOT be treated as terminal.
    expect(mergeSubagentHistory(
      { success: false, completed: false, status: 'error', error: 'Read timed out' },
      { success: true, completed: false, status: 'running' },
    )).toMatchObject({
      success: true,
      status: 'running',
    });
  });

  it('lets a later completed snapshot correct a transient resolution error', () => {
    expect(mergeSubagentHistory(
      { success: false, completed: false, status: 'error', error: 'Read timed out' },
      { success: true, completed: true, status: 'completed' },
    )).toMatchObject({
      success: true,
      completed: true,
      status: 'completed',
    });
  });

  it('rejects responses from an inactive session or provider', () => {expect(isCurrentSubagentResponse(
      { sessionId: 'old-session', provider: 'codex' },
      'current-session',
      'codex',
    )).toBe(false);
    expect(isCurrentSubagentResponse(
      { sessionId: 'current-session', provider: 'claude' },
      'current-session',
      'codex',
    )).toBe(false);
    expect(isCurrentSubagentResponse(
      { sessionId: 'current-session', provider: 'codex' },
      'current-session',
      'codex',
    )).toBe(true);
  });
});
