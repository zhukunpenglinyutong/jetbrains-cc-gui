import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerSessionAndSdkCallbacks } from './sessionCallbacks';

describe('native session titles', () => {
  const restored = vi.fn();
  const custom = vi.fn();
  const local = vi.fn();
  const settle = vi.fn();
  const addToast = vi.fn();
  const setHistoryData = vi.fn();
  const options = { currentSessionIdRef: { current: 'root' }, currentProviderRef: { current: 'codex' },
    customSessionTitleRef: { current: null as string | null }, setRestoredSessionTitle: restored,
    setCustomSessionTitle: custom, applyHistoryTitleLocal: local, settleTitleRegeneration: settle,
    addToast, setHistoryData,
    historyDataRef: { current: null },
  } as unknown as UseWindowCallbacksOptions;
  beforeEach(() => {
    vi.clearAllMocks();
    options.customSessionTitleRef.current = null;
    options.currentProviderRef.current = 'claude';
    options.historyDataRef.current = null;
    registerSessionAndSdkCallbacks(options, { current: ((key: string) => key) as UseWindowCallbacksOptions['t'] });
  });
  it('keeps automatic titles separate from manual overrides', () => {
    window.updateSessionTitle!('root', 'Generated title');
    expect(restored).toHaveBeenCalledWith({ sessionId: 'root', title: 'Generated title' });
    expect(custom).not.toHaveBeenCalled();
    expect(local).toHaveBeenCalledWith('root', 'Generated title');
  });
  it('leaves manual titles and other sessions intact', () => {
    options.customSessionTitleRef.current = 'Manual title';
    window.updateSessionTitle!('root', 'Generated title');
    window.updateSessionTitle!('another-root', 'Late title');
    expect(local).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
    expect(restored).toHaveBeenCalledTimes(1);
  });

  describe('restoreSessionTitle', () => {
    it('applies the persisted title to the current session', () => {
      window.restoreSessionTitle!('root', '  Saved by hand  ');
      expect(custom).toHaveBeenCalledWith('Saved by hand');
    });

    it('ignores titles for other sessions', () => {
      window.restoreSessionTitle!('another-root', 'Saved by hand');
      expect(custom).not.toHaveBeenCalled();
    });

    it('does not overwrite a manual edit that already landed', () => {
      options.customSessionTitleRef.current = 'Newer edit';
      window.restoreSessionTitle!('root', 'Saved by hand');
      expect(custom).not.toHaveBeenCalled();
    });

    it('applies a title that arrived before the callback was registered', () => {
      window.__pendingRestoreSessionTitle = { sessionId: 'root', title: 'Saved before mount' };
      registerSessionAndSdkCallbacks(options, { current: ((key: string) => key) as UseWindowCallbacksOptions['t'] });
      expect(custom).toHaveBeenCalledWith('Saved before mount');
      expect(window.__pendingRestoreSessionTitle).toBeUndefined();
    });

    // Regression: the AI title and the persisted title can arrive in either
    // order after a reload. The persisted manual title must win both times.
    it('wins over an AI title that arrived first', () => {
      window.updateSessionTitle!('root', 'Automatic title');
      window.restoreSessionTitle!('root', 'Saved manual title');
      expect(custom).toHaveBeenCalledTimes(1);
      expect(custom).toHaveBeenCalledWith('Saved manual title');
    });

    it('survives an AI title that arrives later', () => {
      window.restoreSessionTitle!('root', 'Saved manual title');
      window.updateSessionTitle!('root', 'Automatic title');
      expect(custom).toHaveBeenCalledTimes(1);
      expect(custom).toHaveBeenCalledWith('Saved manual title');
      expect(restored).toHaveBeenLastCalledWith({ sessionId: 'root', title: 'Automatic title' });
    });
  });

  // onTitleRegenerated serves both refresh buttons (history list + chat
  // header); it must be usable while the history view is unmounted.
  describe('AI title regeneration results', () => {
    it('applies the new title and settles the spinner on success', () => {
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: true, title: 'Fix login button' }));
      expect(settle).toHaveBeenCalledWith('root');
      expect(local).toHaveBeenCalledWith('root', 'Fix login button');
      expect(addToast).toHaveBeenCalledWith('history.titleRegenerated', 'success');
    });

    // Regression: loading a history session seeds customSessionTitle with the
    // displayed (AI) title and deriveSessionTitle prefers it, so the header
    // only shows the regenerated title if the result pushes it there.
    it('pushes the regenerated title to a seeded on-screen header slot', () => {
      options.customSessionTitleRef.current = 'Old AI title';
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: true, title: 'Fix login button' }));
      expect(custom).toHaveBeenCalledWith('Fix login button');
      expect(restored).not.toHaveBeenCalled();
    });

    // customSessionTitle is reserved for manual edits and seeded titles: an
    // AI title landing there would be persisted as a manual title by the
    // B-011 migration on the next setSessionId switch, permanently disabling
    // regeneration for the session. Fresh sessions route through the restored
    // (AI) slot instead.
    it('routes the title through the AI slot when the manual slot is empty', () => {
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: true, title: 'Fix login button' }));
      expect(restored).toHaveBeenCalledWith({ sessionId: 'root', title: 'Fix login button' });
      expect(custom).not.toHaveBeenCalled();
    });

    it('does not touch the header when the session has a manual title', () => {
      options.historyDataRef.current = { success: true, sessions: [{ sessionId: 'root', title: 'Manual title', hasCustomTitle: true }] };
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: true, title: 'Fix login button' }));
      expect(custom).not.toHaveBeenCalled();
    });

    it('does not touch the header when the regenerated session is not on screen', () => {
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'other-session', success: true, title: 'Other title' }));
      expect(custom).not.toHaveBeenCalled();
    });

    it('maps known failure codes to a friendly toast without touching the title', () => {
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: false, code: 'empty_session' }));
      expect(settle).toHaveBeenCalledWith('root');
      expect(local).not.toHaveBeenCalled();
      expect(addToast).toHaveBeenCalledWith('history.titleRegenerateFailed.emptySession', 'error');
    });
    // The backend guard is the source of truth for manual titles (the UI
    // snapshot can be stale or miss the session). Its response marks the row
    // so both refresh buttons hide without waiting for a history reload.
    it('marks the history row and toasts when the backend reports a manual title', () => {
      options.historyDataRef.current = { success: true, sessions: [{ sessionId: 'root', title: 'Manual title' }] };
      const update = vi.fn();
      setHistoryData.mockImplementation(update);
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: false, code: 'custom_title' }));
      expect(settle).toHaveBeenCalledWith('root');
      expect(addToast).toHaveBeenCalledWith('history.titleRegenerateFailed.customTitle', 'error');
      expect(update).toHaveBeenCalledTimes(1);
      const applyRowUpdate = update.mock.calls[0][0];
      const previous = { success: true, sessions: [{ sessionId: 'root', title: 'Manual title' }, { sessionId: 'other', title: 'Other' }] };
      expect(applyRowUpdate(previous).sessions).toEqual([
        { sessionId: 'root', title: 'Manual title', hasCustomTitle: true },
        { sessionId: 'other', title: 'Other' },
      ]);
    });
    it('falls back to the generic message with the raw error for unknown codes', () => {
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: false, code: 'daemon_timeout', error: 'timed out' }));
      expect(addToast).toHaveBeenCalledWith('history.titleRegenerateFailed.generic: timed out', 'error');
    });
    it('ignores malformed payloads and results without a session id', () => {
      window.onTitleRegenerated!('not json');
      window.onTitleRegenerated!(JSON.stringify({ success: true, title: 'Orphan' }));
      expect(settle).not.toHaveBeenCalled();
      expect(local).not.toHaveBeenCalled();
      expect(addToast).not.toHaveBeenCalled();
    });
  });
});
