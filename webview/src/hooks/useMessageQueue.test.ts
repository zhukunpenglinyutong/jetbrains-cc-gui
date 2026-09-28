import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useMessageQueue } from './useMessageQueue';
import type { QueuedMessage } from './useMessageQueue';
import type { Attachment } from '../components/ChatInputBox/types';

describe('useMessageQueue', () => {
  const renderQueue = (initialLoading: boolean, options?: { asyncLoading?: boolean }) => {
    const onExecute = vi.fn();
    const hook = renderHook(() => {
      // Drive `isLoading` through real component state so the auto-execute
      // path sees the same setState semantics as production, where
      // executeMessage flips loading back on via setLoading(true).
      // asyncLoading skips that flip: the send's loading transition happens
      // asynchronously in production (Java callback), which is exactly the
      // window the single-flight latch must guard.
      const [loading, setLoading] = useState(initialLoading);
      const queueApi = useMessageQueue({
        isLoading: loading,
        onExecute: (content: string, attachments?: Attachment[]) => {
          onExecute(content, attachments);
          if (!options?.asyncLoading) {
            setLoading(true);
          }
        },
      });
      return { queueApi, setLoading };
    });
    return { ...hook, onExecute };
  };

  it('executes the queued message once loading finishes', () => {
    const { result, onExecute } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('queued message');
    });
    expect(onExecute).not.toHaveBeenCalled();

    // Regression: the old implementation deferred execution behind a 50ms
    // timer whose cleanup ran on the dequeue's own re-render, cancelling the
    // timer and silently dropping the already-dequeued message.
    act(() => {
      result.current.setLoading(false);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('queued message', undefined);
    expect(result.current.queueApi.queue).toHaveLength(0);
    expect(result.current.queueApi.hasQueuedMessages).toBe(false);
  });

  it('keeps queued messages waiting while loading', () => {
    const { result, onExecute } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('first');
    });
    act(() => {
      result.current.queueApi.enqueue('second');
    });

    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queueApi.queue).toHaveLength(2);
  });

  it('executes queued messages one by one across turns', () => {
    const { result, onExecute } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('first');
    });
    act(() => {
      result.current.queueApi.enqueue('second');
    });

    act(() => {
      result.current.setLoading(false);
    });
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queueApi.queue).toHaveLength(1);

    act(() => {
      result.current.setLoading(false);
    });
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenLastCalledWith('second', undefined);
    expect(result.current.queueApi.queue).toHaveLength(0);
  });

  it('executes a message enqueued while already idle', () => {
    // Covers the race where the enqueue closure still sees loading=true but
    // the state has already flipped to false — the message must not strand.
    const { result, onExecute } = renderQueue(false);

    act(() => {
      result.current.queueApi.enqueue('late arrival');
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('late arrival', undefined);
    expect(result.current.queueApi.queue).toHaveLength(0);
  });

  it('passes attachments through to onExecute', () => {
    const { result, onExecute } = renderQueue(true);
    const attachment: Attachment = { id: 'att-1', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' };

    act(() => {
      result.current.queueApi.enqueue('with file', [attachment]);
    });
    act(() => {
      result.current.setLoading(false);
    });

    expect(onExecute).toHaveBeenCalledWith('with file', [attachment]);
  });

  it('does not execute messages removed from the queue', () => {
    const { result, onExecute } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('to be removed');
    });
    act(() => {
      result.current.queueApi.dequeue(result.current.queueApi.queue[0].id);
    });
    act(() => {
      result.current.setLoading(false);
    });

    expect(onExecute).not.toHaveBeenCalled();
  });

  it('clearQueue empties the queue', () => {
    const { result, onExecute } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('doomed');
    });
    act(() => {
      result.current.queueApi.clearQueue();
    });
    act(() => {
      result.current.setLoading(false);
    });

    expect(result.current.queueApi.queue).toHaveLength(0);
    expect(result.current.queueApi.hasQueuedMessages).toBe(false);
    expect(onExecute).not.toHaveBeenCalled();
  });
  it('reorders the queue by ordered ids', () => {
    const { result } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('first');
      result.current.queueApi.enqueue('second');
      result.current.queueApi.enqueue('third');
    });
    const [a, b, c] = result.current.queueApi.queue;
    act(() => {
      result.current.queueApi.reorder([c.id, a.id, b.id]);
    });

    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['third', 'first', 'second']);
  });

  it('reorder appends items enqueued mid-drag and ignores unknown or duplicate ids', () => {
    const { result } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('first');
      result.current.queueApi.enqueue('second');
      result.current.queueApi.enqueue('third');
    });
    const [a, , c] = result.current.queueApi.queue;
    // 'second' is absent from orderedIds (as if enqueued mid-drag); the
    // unknown and duplicated ids must be dropped without losing anything.
    act(() => {
      result.current.queueApi.reorder([c.id, 'unknown-id', a.id, a.id]);
    });

    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['third', 'first', 'second']);
  });

  it('defers the next queued row while a steer receipt is outstanding, then dispatches via backstop', () => {
    vi.useFakeTimers();
    try {
      const { result, onExecute } = renderQueue(true);

      act(() => {
        result.current.queueApi.enqueue('steer me');
        result.current.queueApi.enqueue('send after');
      });
      const [first] = result.current.queueApi.queue;
      act(() => {
        result.current.queueApi.markSteering(first.id);
      });
      act(() => {
        result.current.setLoading(false);
      });
      // The undelivered receipt has not landed yet: nothing may dispatch,
      // so the receipt can requeue the steered row at the head first.
      expect(onExecute).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      // Backstop: dispatch the next queued row (steering rows stay hidden).
      expect(onExecute).toHaveBeenCalledTimes(1);
      expect(onExecute).toHaveBeenCalledWith('send after', undefined);
      expect(result.current.queueApi.queue).toHaveLength(1);
      expect(result.current.queueApi.queue[0].status).toBe('steering');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches the requeued undelivered row before older queued rows', () => {
    vi.useFakeTimers();
    try {
      const { result, onExecute } = renderQueue(true);

      act(() => {
        result.current.queueApi.enqueue('steer me');
        result.current.queueApi.enqueue('older queued');
      });
      const [first] = result.current.queueApi.queue;
      act(() => {
        result.current.queueApi.markSteering(first.id);
      });
      act(() => {
        result.current.setLoading(false);
      });
      expect(onExecute).not.toHaveBeenCalled();

      // The undelivered receipt puts the steered row back at the head…
      const steered = result.current.queueApi.steeringItemsRef.current.get(first.id);
      act(() => {
        result.current.queueApi.requeueAtHead(steered!);
      });
      // …and the pending dispatch must pick it (not 'older queued') without
      // waiting for the backstop timer.
      expect(onExecute).toHaveBeenCalledTimes(1);
      expect(onExecute).toHaveBeenCalledWith('steer me', undefined);
      expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['older queued']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispatches exactly one row per idle window when loading flips asynchronously', () => {
    // Plan B2/F2 regression: the window between handing a row to onExecute
    // and the async send flipping isLoading back to true used to re-run the
    // dispatch effect for every remaining row and flush the whole queue into
    // one turn.
    const { result, onExecute } = renderQueue(false, { asyncLoading: true });

    act(() => {
      result.current.queueApi.enqueue('first');
      result.current.queueApi.enqueue('second');
      result.current.queueApi.enqueue('third');
    });
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenNthCalledWith(1, 'first', undefined);
    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['second', 'third']);

    // The turn starts and ends: only then may the next row dispatch.
    act(() => {
      result.current.setLoading(true);
    });
    act(() => {
      result.current.setLoading(false);
    });
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenNthCalledWith(2, 'second', undefined);
  });

  it('restore puts a rejected item back to queued in place', () => {
    const { result } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('first');
      result.current.queueApi.enqueue('second');
    });
    const [first] = result.current.queueApi.queue;
    act(() => {
      result.current.queueApi.markSteering(first.id);
      result.current.queueApi.restore(first.id);
    });

    expect(result.current.queueApi.queue.map(m => m.status)).toEqual(['queued', 'queued']);
    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['first', 'second']);
  });

  it('restore requeues the fallback when the queue row is already gone', () => {
    // Steer plan F1: a receipt must never silently drop its message when a
    // session transition cleared the queue before the receipt landed.
    const { result } = renderQueue(true);
    const fallback: QueuedMessage = { id: 'gone', content: 'rebuilt', queuedAt: 1, status: 'steering' };

    act(() => {
      result.current.queueApi.restore('gone', fallback);
    });

    expect(result.current.queueApi.queue).toHaveLength(1);
    expect(result.current.queueApi.queue[0]).toMatchObject({ id: 'gone', content: 'rebuilt', status: 'queued' });
  });

  it('restore does not duplicate the fallback when the row still exists', () => {
    const { result } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('first');
    });
    const [first] = result.current.queueApi.queue;
    act(() => {
      result.current.queueApi.markSteering(first.id);
      result.current.queueApi.restore(first.id, { ...first, status: 'steering' });
    });

    expect(result.current.queueApi.queue).toHaveLength(1);
    expect(result.current.queueApi.queue[0].status).toBe('queued');
  });

  it('requeueAtHead returns an undelivered item as the next queued send', () => {
    const { result, onExecute } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('steer');
      result.current.queueApi.enqueue('later');
    });
    const [first] = result.current.queueApi.queue;
    act(() => {
      result.current.queueApi.markSteering(first.id);
    });
    const steered = result.current.queueApi.steeringItemsRef.current.get(first.id);
    expect(steered?.status).toBe('steering');
    act(() => {
      result.current.queueApi.requeueAtHead(steered!);
    });
    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['steer', 'later']);
    expect(result.current.queueApi.queue[0].status).toBe('queued');

    act(() => {
      result.current.setLoading(false);
    });
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('steer', undefined);
  });
});
