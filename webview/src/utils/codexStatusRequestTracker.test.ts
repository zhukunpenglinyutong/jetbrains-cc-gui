import { beforeEach, describe, expect, it } from 'vitest';
import {
  isLatestCodexStatusRequest,
  trackCodexStatusRequest,
  trackCodexSubagentTasks,
  isCurrentCodexSubagentTask,
} from './codexStatusRequestTracker';

describe('codexStatusRequestTracker', () => {
  it('rejects a late previous-task report after the same child accepts a followup', () => {
    trackCodexSubagentTasks('task-session', [{ id: 'spawn', nativeTaskId: 'followup-current' }]);
    expect(isCurrentCodexSubagentTask({ sessionId: 'task-session', toolUseId: 'spawn' })).toBe(false);
    expect(isCurrentCodexSubagentTask({ sessionId: 'task-session', toolUseId: 'spawn', nativeTaskId: 'followup-old' })).toBe(false);
    expect(isCurrentCodexSubagentTask({ sessionId: 'task-session', toolUseId: 'spawn', nativeTaskId: 'followup-current' })).toBe(true);
  });
  beforeEach(() => {
    // Reset module state between tests by tracking a known baseline.
    trackCodexStatusRequest('baseline:0');
  });

  it('accepts the most recently sent request', () => {
    trackCodexStatusRequest('session-1:3');
    expect(isLatestCodexStatusRequest('session-1:3')).toBe(true);
  });

  it('rejects responses to superseded requests', () => {
    trackCodexStatusRequest('session-1:4');
    expect(isLatestCodexStatusRequest('session-1:3')).toBe(false);
  });

  it('accepts responses without a requestId (older bridge builds)', () => {
    trackCodexStatusRequest('session-1:5');
    expect(isLatestCodexStatusRequest(undefined)).toBe(true);
  });
});
