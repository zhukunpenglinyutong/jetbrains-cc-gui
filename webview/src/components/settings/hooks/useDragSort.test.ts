import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createEdgeInsertResolver, useDragSort } from './useDragSort';
import type { DropTarget } from './useDragSort';

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
  it('inserts after the target when a custom resolver returns an insert placement', () => {
    const onSort = vi.fn();
    const resolveDropTarget = () => ({ id: 'provider-c', placement: 'after' as const });
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
      { id: 'provider-c', label: 'Provider C' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort, resolveDropTarget }));

    act(() => {
      result.current.handlePointerDown(
        {
          button: 0,
          currentTarget: document.createElement('div'),
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

  it('cancels the drop when the custom resolver returns null on release', () => {
    const onSort = vi.fn();
    const resolveDropTarget = () => null;
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort, resolveDropTarget }));

    act(() => {
      result.current.handlePointerDown(
        {
          button: 0,
          currentTarget: document.createElement('div'),
          clientX: 10,
          clientY: 10,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.PointerEvent,
        'provider-a'
      );
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 90 }));
    });

    expect(onSort).not.toHaveBeenCalled();
    expect(result.current.draggedId).toBeNull();
  });

  it('re-resolves the drop target when the list scrolls under a stationary pointer', () => {
    const onSort = vi.fn();
    let target: DropTarget | null = null;
    const resolveDropTarget = () => target;
    const items: TestItem[] = [
      { id: 'provider-a', label: 'Provider A' },
      { id: 'provider-b', label: 'Provider B' },
    ];

    const { result } = renderHook(() => useDragSort({ items, onSort, resolveDropTarget }));

    act(() => {
      result.current.handlePointerDown(
        {
          button: 0,
          currentTarget: document.createElement('div'),
          clientX: 10,
          clientY: 10,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.PointerEvent,
        'provider-a'
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 90 }));
    });
    expect(result.current.dragOverId).toBeNull();

    // Auto-scroll moved rows under the pointer: the highlight must follow the
    // slot now under the pointer even though no pointermove fired.
    target = { id: 'provider-b', placement: 'after' };
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.dragOverId).toBe('provider-b');
    expect(result.current.dragOverPlacement).toBe('after');

    target = null;
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 90 }));
    });
    expect(onSort).not.toHaveBeenCalled();
  });
});

describe('createEdgeInsertResolver', () => {
  const rect = (top: number, bottom: number): DOMRect => ({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 200,
    bottom,
    width: 200,
    height: bottom - top,
    toJSON: () => ({}),
  });

  // Three 50px rows with 4px gaps inside a container spanning y=100..260
  // (10px top padding, 8px bottom padding). Edge zone = 25% of row height.
  const setupResolver = (options?: { edgeRatio?: number; reversed?: boolean }) => {
    const container = document.createElement('div');
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(rect(100, 260));
    const rows = ['row-a', 'row-b', 'row-c'].map((id) => {
      const row = document.createElement('div');
      row.dataset.dragSortId = id;
      container.appendChild(row);
      return row;
    });
    vi.spyOn(rows[0], 'getBoundingClientRect').mockReturnValue(rect(110, 160));
    vi.spyOn(rows[1], 'getBoundingClientRect').mockReturnValue(rect(164, 214));
    vi.spyOn(rows[2], 'getBoundingClientRect').mockReturnValue(rect(218, 252));
    return createEdgeInsertResolver(() => container, options);
  };

  it('maps container padding and gaps to the adjacent insert slot', () => {
    const resolve = setupResolver();
    expect(resolve(10, 105)).toEqual({ id: 'row-a', placement: 'before' }); // top padding
    expect(resolve(10, 162)).toEqual({ id: 'row-b', placement: 'before' }); // gap a→b
    expect(resolve(10, 255)).toEqual({ id: 'row-c', placement: 'after' }); // bottom padding
  });

  it('splits each row into before / on / after zones', () => {
    const resolve = setupResolver();
    expect(resolve(10, 115)).toEqual({ id: 'row-a', placement: 'before' });
    expect(resolve(10, 135)).toEqual({ id: 'row-a', placement: 'on' });
    expect(resolve(10, 155)).toEqual({ id: 'row-a', placement: 'after' });
  });

  it('returns null horizontally outside, and far beyond the container vertically', () => {
    const resolve = setupResolver();
    expect(resolve(250, 135)).toBeNull();
    expect(resolve(10, 50)).toBeNull();
    expect(resolve(10, 400)).toBeNull();
  });

  it('clamps slight vertical overshoot into the nearest edge slot', () => {
    const resolve = setupResolver();
    // Within the 24px tolerance: releasing here after auto-scroll overshoot
    // must not cancel the drag.
    expect(resolve(10, 90)).toEqual({ id: 'row-a', placement: 'before' });
    expect(resolve(10, 275)).toEqual({ id: 'row-c', placement: 'after' });
  });

  it('flips before/after into items order when reversed', () => {
    const resolve = setupResolver({ reversed: true });
    expect(resolve(10, 105)).toEqual({ id: 'row-a', placement: 'after' });
    expect(resolve(10, 135)).toEqual({ id: 'row-a', placement: 'on' });
    expect(resolve(10, 255)).toEqual({ id: 'row-c', placement: 'before' });
  });
});
