// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BETA_PROVIDER_NOTICE_KEY } from '../utils/betaProviderNotice';
import { useBetaProviderNotice } from './useBetaProviderNotice';

describe('useBetaProviderNotice', () => {
  beforeEach(() => {
    localStorage.removeItem(BETA_PROVIDER_NOTICE_KEY);
  });

  it('runs proceed immediately for non-beta providers', () => {
    const { result } = renderHook(() => useBetaProviderNotice());
    const proceed = vi.fn();

    act(() => {
      result.current.requestSelect(false, proceed);
    });

    expect(proceed).toHaveBeenCalledOnce();
    expect(result.current.isOpen).toBe(false);
  });

  it('shows dialog once for beta providers, then proceeds after close', () => {
    const { result } = renderHook(() => useBetaProviderNotice());
    const proceed = vi.fn();

    act(() => {
      result.current.requestSelect(true, proceed);
    });

    expect(proceed).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(true);

    act(() => {
      result.current.close();
    });

    expect(proceed).toHaveBeenCalledOnce();
    expect(result.current.isOpen).toBe(false);
    expect(localStorage.getItem(BETA_PROVIDER_NOTICE_KEY)).toBe('true');
  });

  it('skips the dialog after the notice was already seen', () => {
    localStorage.setItem(BETA_PROVIDER_NOTICE_KEY, 'true');
    const { result } = renderHook(() => useBetaProviderNotice());
    const proceed = vi.fn();

    act(() => {
      result.current.requestSelect(true, proceed);
    });

    expect(proceed).toHaveBeenCalledOnce();
    expect(result.current.isOpen).toBe(false);
  });
});
