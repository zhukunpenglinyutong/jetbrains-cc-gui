// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BETA_PROVIDER_NOTICE_KEY,
  hasSeenBetaProviderNotice,
  markBetaProviderNoticeSeen,
} from './betaProviderNotice';

describe('betaProviderNotice', () => {
  beforeEach(() => {
    localStorage.removeItem(BETA_PROVIDER_NOTICE_KEY);
  });

  it('defaults to not seen', () => {
    expect(hasSeenBetaProviderNotice()).toBe(false);
  });

  it('marks the notice as seen', () => {
    markBetaProviderNoticeSeen();
    expect(hasSeenBetaProviderNotice()).toBe(true);
    expect(localStorage.getItem(BETA_PROVIDER_NOTICE_KEY)).toBe('true');
  });
});
