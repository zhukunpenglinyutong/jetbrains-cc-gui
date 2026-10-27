import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerSessionAndSdkCallbacks } from './sessionCallbacks';

describe('native session titles', () => {
  const restored = vi.fn();
  const custom = vi.fn();
  const local = vi.fn();
  const settle = vi.fn();
  const addToast = vi.fn();
  const options = { currentSessionIdRef: { current: 'root' }, currentProviderRef: { current: 'codex' },
    customSessionTitleRef: { current: null as string | null }, setRestoredSessionTitle: restored,
    setCustomSessionTitle: custom, applyHistoryTitleLocal: local, settleTitleRegeneration: settle,
    addToast,
  } as unknown as UseWindowCallbacksOptions;
  beforeEach(() => {
    vi.clearAllMocks();
    options.customSessionTitleRef.current = null;
    options.currentProviderRef.current = 'claude';
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
    it('maps known failure codes to a friendly toast without touching the title', () => {
      window.onTitleRegenerated!(JSON.stringify({ sessionId: 'root', success: false, code: 'empty_session' }));
      expect(settle).toHaveBeenCalledWith('root');
      expect(local).not.toHaveBeenCalled();
      expect(addToast).toHaveBeenCalledWith('history.titleRegenerateFailed.emptySession', 'error');
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
