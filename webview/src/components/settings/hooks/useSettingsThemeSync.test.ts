import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsThemeSync } from './useSettingsThemeSync';

describe('useSettingsThemeSync windowOpacity', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to 1.0 when localStorage is empty', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(1.0);
  });

  it('reads valid opacity from localStorage', () => {
    localStorage.setItem('windowOpacity', '0.75');
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(0.75);
  });

  it('clamps value > 1.0 down to 1.0', () => {
    localStorage.setItem('windowOpacity', '1.5');
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(1.0);
  });

  it('clamps negative value up to 0.0', () => {
    localStorage.setItem('windowOpacity', '-0.3');
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(0.0);
  });

  it('defaults to 1.0 for NaN value', () => {
    localStorage.setItem('windowOpacity', 'abc');
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(1.0);
  });

  it('defaults to 1.0 for Infinity', () => {
    localStorage.setItem('windowOpacity', 'Infinity');
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(1.0);
  });

  it('clamps -Infinity to 0.0', () => {
    localStorage.setItem('windowOpacity', '-Infinity');
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(0.0);
  });

  it('sets CSS property and localStorage when opacity < 1.0', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    act(() => {
      result.current.setWindowOpacity(0.6);
    });
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('0.6');
    expect(localStorage.getItem('windowOpacity')).toBe('0.6');
  });

  it('removes CSS property and localStorage when opacity = 1.0', () => {
    localStorage.setItem('windowOpacity', '0.5');
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.windowOpacity).toBe(0.5);
    act(() => {
      result.current.setWindowOpacity(1.0);
    });
    expect(
      document.documentElement.style.getPropertyValue('--window-opacity')
    ).toBe('');
    expect(localStorage.getItem('windowOpacity')).toBeNull();
  });
});
