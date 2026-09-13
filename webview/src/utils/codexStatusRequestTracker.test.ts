import { beforeEach, describe, expect, it } from 'vitest';
import {
  isLatestCodexStatusRequest,
  trackCodexStatusRequest,
} from './codexStatusRequestTracker';

describe('codexStatusRequestTracker', () => {
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
