import { act, renderHook } from '@testing-library/react';
import { useProviderCapabilities } from './useProviderCapabilities';

describe('useProviderCapabilities', () => {
  it('starts with steer disabled until a live turn advertises it', () => {
    const { result } = renderHook(() => useProviderCapabilities());

    expect(result.current.capabilities.steer).toBe(false);
  });

  it('applies the [CAPABILITIES] payload', () => {
    const { result } = renderHook(() => useProviderCapabilities());

    act(() => {
      result.current.applyCapabilities({ steer: true });
    });
    expect(result.current.capabilities.steer).toBe(true);

    act(() => {
      result.current.applyCapabilities({ steer: false });
    });
    expect(result.current.capabilities.steer).toBe(false);
  });

  it('coerces a missing flag to false instead of trusting a truthy payload', () => {
    const { result } = renderHook(() => useProviderCapabilities());

    act(() => {
      result.current.applyCapabilities({} as unknown as { steer: boolean });
    });
    expect(result.current.capabilities.steer).toBe(false);
  });

  it('resets to disabled on a session switch', () => {
    const { result } = renderHook(() => useProviderCapabilities());

    act(() => {
      result.current.applyCapabilities({ steer: true });
    });
    act(() => {
      result.current.resetCapabilities();
    });

    expect(result.current.capabilities.steer).toBe(false);
  });
});
