import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDragSort } from './useDragSort';

interface TestItem {
  id: string;
  label: string;
}

const createDragEvent = (): React.DragEvent => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  dataTransfer: {
    effectAllowed: 'all',
    dropEffect: 'none',
    setData: vi.fn(),
  },
} as unknown as React.DragEvent);

describe('useDragSort', () => {
  it('sorts when drop happens before React has re-rendered drag state', () => {
    const onSort = vi.fn();
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
      { id: 'provider-c', label: 'Provider C' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort }));

    act(() => {
      result.current.handleDragStart(createDragEvent(), 'provider-a');
      result.current.handleDrop(createDragEvent(), 'provider-c');
    });

    expect(onSort).toHaveBeenCalledWith(['provider-b', 'provider-c', 'provider-a']);
    expect(result.current.localItems.map(item => item.id)).toEqual([
      'provider-b',
      'provider-c',
      'provider-a',
    ]);
  });

  it('keeps pinned providers out of the saved order', () => {
    const onSort = vi.fn();
    const items: TestItem[] = [
      { id: 'local-settings', label: 'Local Settings' },
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];

    const { result } = renderHook(() =>
      useDragSort({ items, onSort, pinnedIds: ['local-settings'] })
    );

    act(() => {
      result.current.handleDragStart(createDragEvent(), 'provider-b');
      result.current.handleDrop(createDragEvent(), 'provider-a');
    });

    expect(onSort).toHaveBeenCalledWith(['provider-b', 'provider-a']);
    expect(result.current.localItems.map(item => item.id)).toEqual([
      'local-settings',
      'provider-b',
      'provider-a',
    ]);
  });

  it('stops provider sorting events from reaching global drop guards', () => {
    const onSort = vi.fn();
    const dragStartEvent = createDragEvent();
    const dragOverEvent = createDragEvent();
    const dropEvent = createDragEvent();
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort }));

    act(() => {
      result.current.handleDragStart(dragStartEvent, 'provider-a');
      result.current.handleDragOver(dragOverEvent, 'provider-b');
      result.current.handleDrop(dropEvent, 'provider-b');
    });

    expect(dragStartEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(dragOverEvent.stopPropagation).toHaveBeenCalledTimes(1);
    expect(dropEvent.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('sorts on pointer release when native drop does not fire', () => {
    const onSort = vi.fn();
    const source = document.createElement('div');
    const target = document.createElement('div');
    target.dataset.dragSortId = 'provider-c';
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
      { id: 'provider-c', label: 'Provider C' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort }));

    act(() => {
      result.current.handlePointerDown(
        {
          button: 0,
          currentTarget: source,
          clientX: 10,
          clientY: 10,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.PointerEvent,
        'provider-a'
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 90 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 90 }));
    });

    expect(onSort).toHaveBeenCalledWith(['provider-b', 'provider-c', 'provider-a']);
  });

  it('does not start pointer sorting from interactive controls', () => {
    const onSort = vi.fn();
    const button = document.createElement('button');
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort }));

    act(() => {
      result.current.handlePointerDown(
        {
          button: 0,
          target: button,
          clientX: 10,
          clientY: 10,
          preventDefault,
          stopPropagation,
        } as unknown as React.PointerEvent,
        'provider-a'
      );
    });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(result.current.draggedId).toBeNull();
  });

  it('shows a floating preview while pointer sorting', () => {
    const onSort = vi.fn();
    const source = document.createElement('div');
    source.textContent = 'Provider A';
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 48,
      width: 240,
      height: 48,
      toJSON: () => ({}),
    });
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort }));

    act(() => {
      result.current.handlePointerDown(
        {
          button: 0,
          target: source,
          currentTarget: source,
          clientX: 16,
          clientY: 12,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.PointerEvent,
        'provider-a'
      );
    });

    const preview = document.body.querySelector('[data-drag-sort-preview="true"]');
    expect(preview?.textContent).toBe('Provider A');

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 16, clientY: 12 }));
    });

    expect(document.body.querySelector('[data-drag-sort-preview="true"]')).toBeNull();
  });

  it('keeps pointer offset inside the floating preview', () => {
    const onSort = vi.fn();
    const source = document.createElement('div');
    vi.spyOn(source, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 200,
      top: 200,
      left: 100,
      right: 340,
      bottom: 248,
      width: 240,
      height: 48,
      toJSON: () => ({}),
    });
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort }));

    act(() => {
      result.current.handlePointerDown(
        {
          button: 0,
          target: source,
          currentTarget: source,
          clientX: 116,
          clientY: 212,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.PointerEvent,
        'provider-a'
      );
    });

    const preview = document.body.querySelector('[data-drag-sort-preview="true"]') as HTMLElement | null;
    expect(preview?.style.transform).toContain('translate3d(100px, 200px, 0)');
  });
});
