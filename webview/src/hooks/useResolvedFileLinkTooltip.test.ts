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

  it('shows fallback text when resolution returns null', () => {
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callback(null);
    });

    const absolutePath = 'C:\\Users\\me\\secret.txt';
    const { result } = renderHook(() => useResolvedFileLinkTooltip(absolutePath, absolutePath));

    act(() => {
      result.current.onMouseEnter({ clientX: 12, clientY: 24 } as React.MouseEvent);
    });

    // Local IDE plugin — absolute paths are not sensitive; surface them so
    // the user can see what the link points to even when the backend cannot
    // produce a project-relative display path.
    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe(absolutePath);
  });

  it('shows absolute resolved paths from backend', () => {
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callback('C:\\Users\\me\\secret.txt');
    });

    const { result } = renderHook(() => useResolvedFileLinkTooltip('secret.txt', 'secret.txt'));

    act(() => {
      result.current.onMouseEnter({ clientX: 12, clientY: 24 } as React.MouseEvent);
    });

    expect(document.querySelector('.file-link-tooltip')?.textContent).toBe('C:\\Users\\me\\secret.txt');
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
