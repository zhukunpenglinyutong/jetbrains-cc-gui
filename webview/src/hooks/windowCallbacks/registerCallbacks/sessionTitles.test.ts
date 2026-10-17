import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { registerSessionAndSdkCallbacks } from './sessionCallbacks';

describe('native session titles', () => {
  const restored = vi.fn();
  const custom = vi.fn();
  const local = vi.fn();
  const options = { currentSessionIdRef: { current: 'root' }, currentProviderRef: { current: 'codex' },
    customSessionTitleRef: { current: null as string | null }, setRestoredSessionTitle: restored,
    setCustomSessionTitle: custom, applyHistoryTitleLocal: local,
  } as unknown as UseWindowCallbacksOptions;
  beforeEach(() => {
    vi.clearAllMocks();
    options.customSessionTitleRef.current = null;
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
});
