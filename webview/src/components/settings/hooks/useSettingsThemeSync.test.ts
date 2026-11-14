import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_READY_EVENT } from '../../../utils/bridgeStartup';
import { forceWebviewRepaint } from '../../../utils/forceWebviewRepaint';

let useSettingsThemeSync: typeof import('./useSettingsThemeSync').useSettingsThemeSync;
let useThemeInit: typeof import('../../../hooks/useThemeInit').useThemeInit;
let restoreFontSizeLevel: typeof import('../../../utils/fontSizePreference').restoreFontSizeLevel;
let saveFontSizeLevel: typeof import('../../../utils/fontSizePreference').saveFontSizeLevel;
let bridgeListeners: Array<EventListenerOrEventListenerObject>;

function readSaveRequest(index?: number): { fontSizeLevel: number; fontSizeRequestId: string } {
  const requests = vi.mocked(window.sendToJava!).mock.calls
    .map(([payload]) => payload)
    .filter(payload => payload.startsWith('set_font_size_level:'));
  return JSON.parse(requests[index ?? requests.length - 1].slice('set_font_size_level:'.length));
}

function acknowledgeSelection(): void {
  const request = readSaveRequest();
  restoreFontSizeLevel(request.fontSizeLevel, false, request.fontSizeRequestId);
}

vi.mock('../../../utils/forceWebviewRepaint', () => ({ forceWebviewRepaint: vi.fn() }));

describe('font-size persistence and startup recovery', () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    document.documentElement.style.removeProperty('--font-scale');
    window.sendToJava = vi.fn();
    bridgeListeners = [];
    const addEventListener = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === BRIDGE_READY_EVENT) bridgeListeners.push(listener);
      addEventListener(type, listener, options);
    });
    [{ useSettingsThemeSync }, { useThemeInit }, { restoreFontSizeLevel, saveFontSizeLevel }] = await Promise.all([
      import('./useSettingsThemeSync'),
      import('../../../hooks/useThemeInit'),
      import('../../../utils/fontSizePreference'),
    ]);
  });

  afterEach(() => {
    cleanup();
    for (const listener of bridgeListeners) window.removeEventListener(BRIDGE_READY_EVENT, listener);
    delete window.sendToJava;
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does not save a default merely by opening settings', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    expect(result.current.fontSizeLevel).toBe(3);
    expect(localStorage.getItem('fontSizeLevel')).toBeNull();
    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  it('persists explicit selections through Java and restores them with fresh browser storage', () => {
    const first = renderHook(() => useSettingsThemeSync());
    act(() => first.result.current.setFontSizeLevel(6));
    expect(readSaveRequest()).toEqual({ fontSizeLevel: 6, fontSizeRequestId: expect.any(String) });
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.4');
    act(acknowledgeSelection);
    first.unmount();

    // A new JCEF page after IDE restart has no localStorage entries.
    localStorage.clear();
    document.documentElement.style.removeProperty('--font-scale');
    restoreFontSizeLevel(6);
    const reopened = renderHook(() => useSettingsThemeSync());
    expect(reopened.result.current.fontSizeLevel).toBe(6);
    expect(localStorage.getItem('fontSizeLevel')).toBe('6');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.4');
  });

  it('restores a fresh page from the startup payload before settings mounts', () => {
    restoreFontSizeLevel(5, true);
    const { result } = renderHook(() => {
      useThemeInit();
      return useSettingsThemeSync();
    });
    expect(result.current.fontSizeLevel).toBe(5);
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
    expect(window.sendToJava).not.toHaveBeenCalledWith(expect.stringMatching(/^set_font_size_level:/));
  });

  it('updates settings when startup recovery arrives after React mounts without saving it again', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    act(() => restoreFontSizeLevel(5));
    expect(result.current.fontSizeLevel).toBe(5);
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  it('applies explicit choices and notifies mounted settings without waiting for a save acknowledgement', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    act(() => saveFontSizeLevel(5));
    expect(result.current.fontSizeLevel).toBe(5);
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
    expect(readSaveRequest().fontSizeLevel).toBe(5);
  });

  it('repaints once when a restored value is delivered through both font callbacks', () => {
    renderHook(() => useSettingsThemeSync());
    act(() => restoreFontSizeLevel(5));
    act(() => restoreFontSizeLevel(5));
    expect(forceWebviewRepaint).toHaveBeenCalledTimes(1);
  });

  it('does not let a late startup response overwrite a newer explicit choice', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    act(() => result.current.setFontSizeLevel(4));
    act(() => restoreFontSizeLevel(2));
    act(() => restoreFontSizeLevel(null));
    expect(result.current.fontSizeLevel).toBe(4);
    expect(localStorage.getItem('fontSizeLevel')).toBe('4');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.1');
    act(acknowledgeSelection);
    expect(result.current.fontSizeLevel).toBe(4);
  });

  it('ignores an older startup payload even after the latest choice has been acknowledged', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    act(() => result.current.setFontSizeLevel(6));
    act(acknowledgeSelection);
    act(() => restoreFontSizeLevel(2, true));
    expect(result.current.fontSizeLevel).toBe(6);
    expect(localStorage.getItem('fontSizeLevel')).toBe('6');
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.4');
  });

  it('keeps the latest choice when older saves revisit the same level', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    for (const level of [6, 2, 6]) act(() => result.current.setFontSizeLevel(level));
    const first = readSaveRequest(0);
    const second = readSaveRequest(1);
    const latest = readSaveRequest(2);

    act(() => restoreFontSizeLevel(first.fontSizeLevel, false, first.fontSizeRequestId));
    act(() => restoreFontSizeLevel(second.fontSizeLevel, false, second.fontSizeRequestId));
    expect(result.current.fontSizeLevel).toBe(6);
    expect(localStorage.getItem('fontSizeLevel')).toBe('6');

    act(() => restoreFontSizeLevel(latest.fontSizeLevel, false, latest.fontSizeRequestId));
    act(() => restoreFontSizeLevel(second.fontSizeLevel, false, second.fontSizeRequestId));
    expect(result.current.fontSizeLevel).toBe(6);
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.4');
  });

  it('persists and restores scale when browser storage cannot cache it', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation((key) => {
      if (key === 'fontSizeLevel') throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });
    const { result, unmount } = renderHook(() => useSettingsThemeSync());
    act(() => result.current.setFontSizeLevel(5));
    expect(readSaveRequest().fontSizeLevel).toBe(5);
    act(acknowledgeSelection);
    expect(result.current.fontSizeLevel).toBe(5);
    expect(localStorage.getItem('fontSizeLevel')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
    unmount();
    const reopened = renderHook(() => {
      useThemeInit();
      return useSettingsThemeSync();
    });
    expect(reopened.result.current.fontSizeLevel).toBe(5);
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.2');
  });

  it('catches recovery between the settings render and effect subscription', () => {
    const { result } = renderHook(() => {
      const settings = useSettingsThemeSync();
      useLayoutEffect(() => restoreFontSizeLevel(6), []);
      return settings;
    });
    expect(result.current.fontSizeLevel).toBe(6);
    expect(document.documentElement.style.getPropertyValue('--font-scale')).toBe('1.4');
  });

  it('migrates a legacy explicit choice but never pins an absent default', () => {
    restoreFontSizeLevel(null);
    expect(window.sendToJava).not.toHaveBeenCalled();
    localStorage.setItem('fontSizeLevel', '2');
    restoreFontSizeLevel(null);
    expect(readSaveRequest().fontSizeLevel).toBe(2);
  });

  it('does not migrate malformed or non-decimal browser cache values', () => {
    for (const stored of ['2.5', '0', '7', '0x2', '0b10', '2e0', '2junk', '', ' 2 ']) {
      localStorage.setItem('fontSizeLevel', stored);
      restoreFontSizeLevel(null);
      expect(window.sendToJava).not.toHaveBeenCalled();
      expect(localStorage.getItem('fontSizeLevel')).toBe(stored);
    }
  });

  it('rejects invalid selections and malformed backend values', () => {
    const { result } = renderHook(() => useSettingsThemeSync());
    for (const level of [0, 7, 2.5, Number.NaN]) {
      act(() => result.current.setFontSizeLevel(level));
      act(() => restoreFontSizeLevel(level));
    }
    act(() => restoreFontSizeLevel(undefined));
    act(() => restoreFontSizeLevel('5'));
    expect(result.current.fontSizeLevel).toBe(3);
    expect(localStorage.getItem('fontSizeLevel')).toBeNull();
    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  it('publishes the latest selection once a delayed bridge becomes ready', () => {
    delete window.sendToJava;
    const { result } = renderHook(() => useSettingsThemeSync());
    act(() => result.current.setFontSizeLevel(2));
    act(() => result.current.setFontSizeLevel(5));
    window.sendToJava = vi.fn();
    act(() => window.dispatchEvent(new Event(BRIDGE_READY_EVENT)));
    expect(window.sendToJava).toHaveBeenCalledTimes(1);
    expect(readSaveRequest()).toEqual({ fontSizeLevel: 5, fontSizeRequestId: expect.any(String) });
  });
});
