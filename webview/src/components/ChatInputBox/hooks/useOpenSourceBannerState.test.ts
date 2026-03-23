import { renderHook, act } from '@testing-library/react';
import { useOpenSourceBannerState } from './useOpenSourceBannerState.js';

describe('useOpenSourceBannerState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('shows the banner until it is dismissed', () => {
    const { result } = renderHook(() => useOpenSourceBannerState());

    expect(result.current.showOpenSourceBanner).toBe(true);

    act(() => {
      result.current.handleDismissOpenSourceBanner();
    });

    expect(result.current.showOpenSourceBanner).toBe(false);
    expect(window.localStorage.getItem('openSourceBannerDismissed')).toBe('true');
  });

  it('starts hidden when localStorage already contains the dismissal flag', () => {
    window.localStorage.setItem('openSourceBannerDismissed', 'true');
    const { result } = renderHook(() => useOpenSourceBannerState());

    expect(result.current.showOpenSourceBanner).toBe(false);
  });
});
