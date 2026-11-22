import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS,
  MAX_HISTORY_LOAD_TIMEOUT_SECONDS,
  MIN_HISTORY_LOAD_TIMEOUT_SECONDS,
  clampHistoryLoadTimeoutSeconds,
} from './historyLoadTimeout';

describe('clampHistoryLoadTimeoutSeconds', () => {
  it('clamps numeric values to the supported range', () => {
    expect(clampHistoryLoadTimeoutSeconds(1)).toBe(MIN_HISTORY_LOAD_TIMEOUT_SECONDS);
    expect(clampHistoryLoadTimeoutSeconds(30)).toBe(30);
    expect(clampHistoryLoadTimeoutSeconds(999)).toBe(MAX_HISTORY_LOAD_TIMEOUT_SECONDS);
  });

  it('uses the default for an invalid input', () => {
    expect(clampHistoryLoadTimeoutSeconds('')).toBe(DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS);
    expect(clampHistoryLoadTimeoutSeconds('invalid')).toBe(DEFAULT_HISTORY_LOAD_TIMEOUT_SECONDS);
  });
});
