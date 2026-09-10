import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useMessageQueue } from './useMessageQueue';
import type { Attachment } from '../components/ChatInputBox/types';

describe('useMessageQueue', () => {
  const renderQueue = (initialLoading: boolean) => {
    const onExecute = vi.fn();
    const hook = renderHook(() => {
      // Drive `isLoading` through real component state so the auto-execute
      // path sees the same setState semantics as production, where
      // executeMessage flips loading back on via setLoading(true).
      const [loading, setLoading] = useState(initialLoading);
      const queueApi = useMessageQueue({
        isLoading: loading,
        onExecute: (content: string, attachments?: Attachment[]) => {
          onExecute(content, attachments);
          setLoading(true);
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
});
