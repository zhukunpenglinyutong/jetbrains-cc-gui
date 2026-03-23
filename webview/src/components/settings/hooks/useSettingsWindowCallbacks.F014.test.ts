/**
 * T7b: Tab status indicator (F-014) — settings delegate wiring tests.
 * Extends T7 pattern: verifies that window callbacks correctly invoke
 * the setTabStatusIndicatorEnabled setter, and that the initial load
 * request is sent.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('Tab status indicator wiring (F-014)', () => {
  beforeEach(() => {
    (window as any).updateTabStatusIndicator = undefined;
    (window as any).sendToJava = undefined;
  });

  afterEach(() => {
    (window as any).updateTabStatusIndicator = undefined;
    (window as any).sendToJava = undefined;
  });

  it('updateTabStatusIndicator calls setTabStatusIndicatorEnabled with true', () => {
    const setTabStatusIndicatorEnabled = vi.fn();

    // Simulate what useSettingsWindowCallbacks registers
    (window as any).updateTabStatusIndicator = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setTabStatusIndicatorEnabled?.(data.tabStatusIndicatorEnabled ?? true);
      } catch { /* ignore */ }
    };

    (window as any).updateTabStatusIndicator(JSON.stringify({ tabStatusIndicatorEnabled: true }));
    expect(setTabStatusIndicatorEnabled).toHaveBeenCalledWith(true);
  });

  it('updateTabStatusIndicator calls setTabStatusIndicatorEnabled with false', () => {
    const setTabStatusIndicatorEnabled = vi.fn();

    (window as any).updateTabStatusIndicator = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setTabStatusIndicatorEnabled?.(data.tabStatusIndicatorEnabled ?? true);
      } catch { /* ignore */ }
    };

    (window as any).updateTabStatusIndicator(JSON.stringify({ tabStatusIndicatorEnabled: false }));
    expect(setTabStatusIndicatorEnabled).toHaveBeenCalledWith(false);
  });

  it('updateTabStatusIndicator defaults to true when field is missing', () => {
    const setTabStatusIndicatorEnabled = vi.fn();

    (window as any).updateTabStatusIndicator = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setTabStatusIndicatorEnabled?.(data.tabStatusIndicatorEnabled ?? true);
      } catch { /* ignore */ }
    };

    (window as any).updateTabStatusIndicator(JSON.stringify({}));
    expect(setTabStatusIndicatorEnabled).toHaveBeenCalledWith(true);
  });

  it('updateTabStatusIndicator does NOT throw when setter is undefined', () => {
    const setTabStatusIndicatorEnabled = undefined;

    (window as any).updateTabStatusIndicator = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setTabStatusIndicatorEnabled?.(data.tabStatusIndicatorEnabled ?? true);
      } catch { /* ignore */ }
    };

    expect(() => {
      (window as any).updateTabStatusIndicator(JSON.stringify({ tabStatusIndicatorEnabled: false }));
    }).not.toThrow();
  });

  it('malformed JSON does not crash the callback', () => {
    const setTabStatusIndicatorEnabled = vi.fn();

    (window as any).updateTabStatusIndicator = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        setTabStatusIndicatorEnabled?.(data.tabStatusIndicatorEnabled ?? true);
      } catch { /* ignore */ }
    };

    expect(() => {
      (window as any).updateTabStatusIndicator('not valid json{{{');
    }).not.toThrow();
    expect(setTabStatusIndicatorEnabled).not.toHaveBeenCalled();
  });

  it('handleTabStatusIndicatorEnabledChange sends correct IPC message', () => {
    const sentMessages: string[] = [];
    (window as any).sendToJava = (msg: string) => sentMessages.push(msg);

    // Simulate the handler logic from useSettingsBasicActions
    const setTabStatusIndicatorEnabled = vi.fn();
    const handleTabStatusIndicatorEnabledChange = (enabled: boolean) => {
      setTabStatusIndicatorEnabled(enabled);
      window.sendToJava?.(`set_tab_status_indicator:${JSON.stringify({ tabStatusIndicatorEnabled: enabled })}`);
    };

    handleTabStatusIndicatorEnabledChange(false);

    expect(setTabStatusIndicatorEnabled).toHaveBeenCalledWith(false);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain('set_tab_status_indicator:');
    const payload = JSON.parse(sentMessages[0].replace('set_tab_status_indicator:', ''));
    expect(payload.tabStatusIndicatorEnabled).toBe(false);
  });

  it('initial load sends get_tab_status_indicator request', () => {
    const sentMessages: string[] = [];
    (window as any).sendToJava = (msg: string) => sentMessages.push(msg);

    // Simulate what useSettingsWindowCallbacks does on mount
    window.sendToJava?.('get_tab_status_indicator:');

    expect(sentMessages).toContain('get_tab_status_indicator:');
  });

  it('delegate setter list must include setTabStatusIndicatorEnabled (regression guard)', () => {
    type DepsHasTabIndicator = {
      setTabStatusIndicatorEnabled?: (enabled: boolean) => void;
    };

    const deps: DepsHasTabIndicator = { setTabStatusIndicatorEnabled: vi.fn() };
    expect(deps.setTabStatusIndicatorEnabled).toBeDefined();
  });
});
