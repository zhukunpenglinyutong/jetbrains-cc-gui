import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useResolvedFileLinkTooltip } from './useResolvedFileLinkTooltip';

const bridgeMocks = vi.hoisted(() => ({
  resolveFilePathWithCallback: vi.fn(),
}));

vi.mock('../utils/bridge', () => ({
  resolveFilePathWithCallback: bridgeMocks.resolveFilePathWithCallback,
}));

describe('useResolvedFileLinkTooltip', () => {
  beforeEach(() => {
    bridgeMocks.resolveFilePathWithCallback.mockReset();
    document.querySelectorAll('.file-link-tooltip').forEach((element) => element.remove());
  });

  it('resolves file path only when hovered', () => {
    const callbacks: Array<(result: string | null) => void> = [];
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callbacks.push(callback);
    });

    const { result } = renderHook(() => useResolvedFileLinkTooltip('src/App.tsx', 'App.tsx'));

    expect(bridgeMocks.resolveFilePathWithCallback).not.toHaveBeenCalled();

    act(() => {
      result.current.onMouseEnter({ clientX: 12, clientY: 24 } as React.MouseEvent);
    });

    expect(bridgeMocks.resolveFilePathWithCallback).toHaveBeenCalledWith('src/App.tsx', expect.any(Function));
    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('App.tsx');

    act(() => {
      callbacks[0]?.('src/App.tsx');
    });

    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('src/App.tsx');
  });

  it('does not show raw absolute fallback when resolution returns null', () => {
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callback(null);
    });

    const absolutePath = 'C:\\Users\\me\\secret.txt';
    const { result } = renderHook(() => useResolvedFileLinkTooltip(absolutePath, absolutePath));

    act(() => {
      result.current.onMouseEnter({ clientX: 12, clientY: 24 } as React.MouseEvent);
    });

    expect(document.querySelector('.file-link-tooltip')).toBeNull();
  });

  it('does not show absolute resolved paths from backend', () => {
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callback('C:\\Users\\me\\secret.txt');
    });

    const { result } = renderHook(() => useResolvedFileLinkTooltip('secret.txt', 'secret.txt'));

    act(() => {
      result.current.onMouseEnter({ clientX: 12, clientY: 24 } as React.MouseEvent);
    });

    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('secret.txt');
  });

  it('does not create tooltip after unmount while resolve is pending', () => {
    const callbacks: Array<(result: string | null) => void> = [];
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callbacks.push(callback);
    });

    const { result, unmount } = renderHook(() => useResolvedFileLinkTooltip('src/App.tsx', 'App.tsx'));

    act(() => {
      result.current.onMouseEnter({ clientX: 12, clientY: 24 } as React.MouseEvent);
    });
    unmount();
    act(() => {
      callbacks[0]?.('src/App.tsx');
    });

    expect(document.querySelector('.file-link-tooltip')).toBeNull();
  });
});
