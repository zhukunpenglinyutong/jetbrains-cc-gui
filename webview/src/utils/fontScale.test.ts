import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FONT_SIZE_LEVEL,
  FONT_SIZE_LEVEL_STORAGE_KEY,
  fontSizeLevelToScale,
  isValidFontSizeLevel,
  parseFontSizeLevel,
} from './fontScale';

describe('isValidFontSizeLevel', () => {
  it('accepts integers within 1-6', () => {
    expect(isValidFontSizeLevel(1)).toBe(true);
    expect(isValidFontSizeLevel(6)).toBe(true);
  });

  it('rejects out-of-range and non-integer levels', () => {
    expect(isValidFontSizeLevel(0)).toBe(false);
    expect(isValidFontSizeLevel(7)).toBe(false);
    expect(isValidFontSizeLevel(2.5)).toBe(false);
    expect(isValidFontSizeLevel(Number.NaN)).toBe(false);
  });
});

describe('fontSizeLevelToScale', () => {
  it('maps every valid level', () => {
    expect(fontSizeLevelToScale(1)).toBe(0.8);
    expect(fontSizeLevelToScale(2)).toBe(0.9);
    expect(fontSizeLevelToScale(3)).toBe(1.0);
    expect(fontSizeLevelToScale(4)).toBe(1.1);
    expect(fontSizeLevelToScale(5)).toBe(1.2);
    expect(fontSizeLevelToScale(6)).toBe(1.4);
  });

  it('falls back to 1.0 for unknown levels', () => {
    expect(fontSizeLevelToScale(99)).toBe(1.0);
  });
});

describe('parseFontSizeLevel', () => {
  it('parses valid stored levels', () => {
    expect(parseFontSizeLevel('5')).toBe(5);
    expect(parseFontSizeLevel('2')).toBe(2);
  });

  it('resolves absent or invalid values to the default level', () => {
    expect(parseFontSizeLevel(null)).toBe(DEFAULT_FONT_SIZE_LEVEL);
    expect(parseFontSizeLevel('')).toBe(DEFAULT_FONT_SIZE_LEVEL);
    expect(parseFontSizeLevel('abc')).toBe(DEFAULT_FONT_SIZE_LEVEL);
    expect(parseFontSizeLevel('0')).toBe(DEFAULT_FONT_SIZE_LEVEL);
    expect(parseFontSizeLevel('9')).toBe(DEFAULT_FONT_SIZE_LEVEL);
  });

  it('never mutates storage', () => {
    localStorage.setItem(FONT_SIZE_LEVEL_STORAGE_KEY, '2');
    parseFontSizeLevel(localStorage.getItem(FONT_SIZE_LEVEL_STORAGE_KEY));
    expect(localStorage.getItem(FONT_SIZE_LEVEL_STORAGE_KEY)).toBe('2');
  });
});
