import { act, renderHook } from '@testing-library/react';
import { useDiagnosticRingBuffer } from './useDiagnosticRingBuffer.js';

describe('useDiagnosticRingBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes events and returns them via getEvents', () => {
    const { result } = renderHook(() => useDiagnosticRingBuffer(true));

    act(() => {
      result.current.pushEvent('scroll_jump', { distance: 100 });
      result.current.pushEvent('stream_start');
    });

    const events = result.current.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('scroll_jump');
    expect(events[0].data).toEqual({ distance: 100 });
    expect(events[1].type).toBe('stream_start');
  });

  it('is a no-op when disabled', () => {
    const { result } = renderHook(() => useDiagnosticRingBuffer(false));

    act(() => {
      result.current.pushEvent('scroll_jump');
      result.current.pushEvent('stream_start');
    });

    expect(result.current.getEvents()).toHaveLength(0);
  });

  it('evicts events older than maxAgeMs', () => {
    const { result } = renderHook(() =>
      useDiagnosticRingBuffer(true, 1000, 500),
    );

    act(() => {
      result.current.pushEvent('old_event');
    });

    // Advance time past the max age
    act(() => {
      vi.advanceTimersByTime(1500);
      result.current.pushEvent('new_event');
    });

    const events = result.current.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('new_event');
  });

  it('caps buffer at maxSize', () => {
    const { result } = renderHook(() =>
      useDiagnosticRingBuffer(true, 60_000, 3),
    );

    act(() => {
      result.current.pushEvent('a');
      result.current.pushEvent('b');
      result.current.pushEvent('c');
      result.current.pushEvent('d');
    });

    const events = result.current.getEvents();
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('b');
    expect(events[1].type).toBe('c');
    expect(events[2].type).toBe('d');
  });

  it('clear() removes all events and unfreezes', () => {
    const { result } = renderHook(() => useDiagnosticRingBuffer(true));

    act(() => {
      result.current.pushEvent('a');
      result.current.freeze();
      result.current.clear();
    });

    expect(result.current.getEvents()).toHaveLength(0);

    // After clear, new events should flow into live buffer
    act(() => {
      result.current.pushEvent('b');
    });
    expect(result.current.getEvents()).toHaveLength(1);
    expect(result.current.getEvents()[0].type).toBe('b');
  });

  describe('freeze / unfreeze', () => {
    it('freeze() snapshots current events', () => {
      const { result } = renderHook(() => useDiagnosticRingBuffer(true));

      act(() => {
        result.current.pushEvent('before_freeze');
        result.current.freeze();
      });

      // Events added after freeze should NOT appear in getEvents
      act(() => {
        result.current.pushEvent('after_freeze');
      });

      const frozen = result.current.getEvents();
      expect(frozen).toHaveLength(1);
      expect(frozen[0].type).toBe('before_freeze');
    });

    it('unfreeze() returns to live buffer including events added during freeze', () => {
      const { result } = renderHook(() => useDiagnosticRingBuffer(true));

      act(() => {
        result.current.pushEvent('before');
        result.current.freeze();
        result.current.pushEvent('during');
        result.current.unfreeze();
      });

      const live = result.current.getEvents();
      expect(live).toHaveLength(2);
      expect(live[0].type).toBe('before');
      expect(live[1].type).toBe('during');
    });
  });

  it('getEvents returns a copy, not the internal buffer', () => {
    const { result } = renderHook(() => useDiagnosticRingBuffer(true));

    act(() => {
      result.current.pushEvent('a');
    });

    const events1 = result.current.getEvents();
    const events2 = result.current.getEvents();
    expect(events1).not.toBe(events2);
    expect(events1).toEqual(events2);
  });
});
