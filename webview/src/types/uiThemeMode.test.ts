import { describe, expect, it } from 'vitest';
import {
  isExplicitUiThemeMode,
  isUiThemeMode,
  resolveThemeAttribute,
} from './uiThemeMode';

describe('ui theme mode', () => {
  it('accepts the Copilot inspired skin as a first-class theme mode', () => {
    expect(isUiThemeMode('github-copilot')).toBe(true);
    expect(isExplicitUiThemeMode('github-copilot')).toBe(true);
    expect(resolveThemeAttribute('github-copilot', 'light')).toBe('github-copilot');
  });

  it('keeps system mode bound to the IDE theme', () => {
    expect(resolveThemeAttribute('system', 'dark')).toBe('dark');
    expect(resolveThemeAttribute('system', null)).toBeNull();
  });

  it('rejects unknown localStorage values', () => {
    expect(isUiThemeMode('copilot')).toBe(false);
    expect(isExplicitUiThemeMode('system')).toBe(false);
  });
});
