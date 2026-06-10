import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useThemeInit } from './useThemeInit';

describe('useThemeInit theme initialization', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--window-opacity');
  });

  it('initializes windowOpacity from localStorage', () => {
    localStorage.setItem('windowOpacity', '0.6');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('0.6');
  });

  it('does not set CSS property when opacity is 1.0', () => {
    localStorage.setItem('windowOpacity', '1.0');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('clamps value > 1.0 and does not set CSS property', () => {
    localStorage.setItem('windowOpacity', '1.5');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('ignores negative value and does not set CSS property', () => {
    localStorage.setItem('windowOpacity', '-0.2');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('ignores NaN value and does not set CSS property', () => {
    localStorage.setItem('windowOpacity', 'abc');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });
});
