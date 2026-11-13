import { describe, expect, it } from 'vitest';
import { CUSTOM_TITLE_MAX_LENGTH, truncateToCodeUnits } from './sessionTitleLimit';

describe('truncateToCodeUnits', () => {
  it('leaves short values untouched', () => {
    expect(truncateToCodeUnits('hello', 10)).toBe('hello');
    expect(truncateToCodeUnits('hello', 5)).toBe('hello');
  });

  it('cuts at the code-unit limit', () => {
    expect(truncateToCodeUnits('x'.repeat(30), 20)).toBe('x'.repeat(20));
  });

  it('returns an empty string once the budget is spent', () => {
    expect(truncateToCodeUnits('hello', 0)).toBe('');
    expect(truncateToCodeUnits('hello', -1)).toBe('');
  });

  it('backs off rather than splitting a surrogate pair at the cut', () => {
    // 19 units + an emoji pair straddling the cut at 20.
    const value = 'x'.repeat(19) + '😀' + 'y';
    expect(value.length).toBe(22);
    const cut = truncateToCodeUnits(value, 20);
    expect(cut).toBe('x'.repeat(19));
    expect(cut.includes('😀')).toBe(false);
  });

  it('keeps a pair that fits entirely inside the window', () => {
    const value = 'x'.repeat(18) + '😀' + 'y';
    const cut = truncateToCodeUnits(value, 20);
    expect(cut).toBe('x'.repeat(18) + '😀');
    expect(cut.length).toBe(20);
  });

  it('exposes the service limit the backend and titles service share', () => {
    expect(CUSTOM_TITLE_MAX_LENGTH).toBe(50);
  });
});
