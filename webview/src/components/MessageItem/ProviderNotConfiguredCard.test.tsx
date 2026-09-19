import { describe, expect, it } from 'vitest';
import { isProviderNotConfiguredError } from './providerNotConfigured';

describe('isProviderNotConfiguredError', () => {
  it('matches legacy provider-not-configured errors', () => {
    expect(isProviderNotConfiguredError('API Key not configured')).toBe(true);
  });

  it('matches Codex local access authorization errors', () => {
    expect(
      isProviderNotConfiguredError(
        'Codex local configuration access is not authorized. Please authorize local ~/.codex access first.'
      )
    ).toBe(true);
    expect(
      isProviderNotConfiguredError(
        'Codex 本地配置读取未获授权。请先授权读取 ~/.codex，或先启用一个受管的 Codex 供应商。'
      )
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isProviderNotConfiguredError('Network timeout')).toBe(false);
  });
});
