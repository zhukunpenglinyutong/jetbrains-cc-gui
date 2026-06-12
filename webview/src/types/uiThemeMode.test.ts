import { describe, expect, it } from 'vitest';
import {
  isExplicitUiThemeMode,
  isUiThemeMode,
  resolveThemeAttribute,
} from './uiThemeMode';

describe('ui theme mode', () => {
  it('accepts the CoDriver skin as a first-class theme mode', () => {
    expect(isUiThemeMode('codriver')).toBe(true);
    expect(isExplicitUiThemeMode('codriver')).toBe(true);
    expect(resolveThemeAttribute('codriver', 'light')).toBe('codriver');
  });

  it('keeps system mode bound to the IDE theme', () => {
    expect(resolveThemeAttribute('system', 'dark')).toBe('dark');
    expect(resolveThemeAttribute('system', null)).toBeNull();
  });

  it('rejects unknown localStorage values', () => {
    expect(isUiThemeMode('solarized')).toBe(false);
    expect(isExplicitUiThemeMode('system')).toBe(false);
  });
});
