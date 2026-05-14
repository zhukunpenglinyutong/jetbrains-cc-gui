import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useResolvedFilePath } from './useResolvedFilePath';

const bridgeMocks = vi.hoisted(() => ({
  resolveFilePathWithCallback: vi.fn(),
}));

vi.mock('../utils/bridge', () => ({
  resolveFilePathWithCallback: bridgeMocks.resolveFilePathWithCallback,
}));

describe('useResolvedFilePath', () => {
  beforeEach(() => {
    bridgeMocks.resolveFilePathWithCallback.mockReset();
  });

  it('clears stale resolved path when file path changes', () => {
    const callbacks: Array<(result: string | null) => void> = [];
    bridgeMocks.resolveFilePathWithCallback.mockImplementation((_path: string, callback: (result: string | null) => void) => {
      callbacks.push(callback);
    });

    const { result, rerender } = renderHook(
      ({ filePath }: { filePath: string | undefined }) => useResolvedFilePath(filePath),
      { initialProps: { filePath: 'src/first.ts' } },
    );

    act(() => {
      callbacks[0]?.('src/first.ts');
    });
    expect(result.current).toBe('src/first.ts');

    rerender({ filePath: 'src/second.ts' });

    expect(result.current).toBeUndefined();
  });
});
