import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThemeInit } from './useThemeInit';

describe('useThemeInit windowOpacity initialization', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--window-opacity');
  });

  it('does not set CSS property when localStorage is empty', () => {
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('sets CSS property for valid opacity < 1.0', () => {
    localStorage.setItem('windowOpacity', '0.6');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('0.6');
  });

  it('does not set CSS property when opacity = 1.0', () => {
    localStorage.setItem('windowOpacity', '1.0');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('clamps value > 1.0 down to 1.0 and does not set CSS property', () => {
    localStorage.setItem('windowOpacity', '1.5');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('clamps negative value up to 0.0 and sets CSS property', () => {
    localStorage.setItem('windowOpacity', '-0.2');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('0');
  });

  it('treats NaN value as 1.0 and does not set CSS property', () => {
    localStorage.setItem('windowOpacity', 'abc');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('treats Infinity as 1.0 and does not set CSS property', () => {
    localStorage.setItem('windowOpacity', 'Infinity');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
  });

  it('clamps -Infinity to 0.0 and sets CSS property', () => {
    localStorage.setItem('windowOpacity', '-Infinity');
    renderHook(() => useThemeInit());
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('0');
  });
});
