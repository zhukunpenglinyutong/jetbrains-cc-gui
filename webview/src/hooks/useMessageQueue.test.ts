import { act, renderHook } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import { useMessageQueue } from './useMessageQueue';
import type { QueuedMessage } from './useMessageQueue';
import type { Attachment } from '../components/ChatInputBox/types';
import {
  expandQuoteTokens,
  makeQuoteToken,
  pruneQuoteRegistry,
  registerQuote,
} from '../components/ChatInputBox/utils/quoteRegistry';

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

  it('dispatches at most one message per idle period until loading flips', () => {
    const onExecute = vi.fn();
    const hook = renderHook(() => useMessageQueue({ isLoading: false, onExecute }));

    act(() => {
      hook.result.current.enqueue('first');
      hook.result.current.enqueue('second');
    });

    // The synchronous re-render after the first dispatch must not drain
    // 'second' too — overlapping sends on one Codex thread hit the
    // thread-writer lock conflict.
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(hook.result.current.queue.map(m => m.content)).toEqual(['second']);
  });

  it('reopens the single-flight gate through a loading cycle', () => {
    const onExecute = vi.fn();
    const hook = renderHook(() => {
      const [loading, setLoading] = useState(false);
      const queueApi = useMessageQueue({ isLoading: loading, onExecute });
      return { queueApi, setLoading };
    });

    act(() => {
      hook.result.current.queueApi.enqueue('only');
    });
    // Dispatch happened (loading never flipped: the execute path bailed).
    expect(onExecute).toHaveBeenCalledTimes(1);

    // A later turn (loading true → false) reopens the gate.
    act(() => {
      hook.result.current.setLoading(true);
    });
    act(() => {
      hook.result.current.setLoading(false);
    });
    expect(onExecute).toHaveBeenCalledTimes(1);

    act(() => {
      hook.result.current.queueApi.enqueue('next round');
    });
    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenLastCalledWith('next round', undefined);
  });

  it('dequeueForEdit removes the message and returns its content and attachments', () => {
    const { result } = renderQueue(true);
    const attachment: Attachment = { id: 'att-1', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' };

    act(() => {
      result.current.queueApi.enqueue('first');
      result.current.queueApi.enqueue('edit me', [attachment]);
      result.current.queueApi.enqueue('third');
    });

    const target = result.current.queueApi.queue[1];
    let removed: QueuedMessage | undefined;
    act(() => {
      removed = result.current.queueApi.dequeueForEdit(target.id);
    });

    expect(removed).toMatchObject({ content: 'edit me', attachments: [attachment] });
    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['first', 'third']);
    expect(result.current.queueApi.hasQueuedMessages).toBe(true);
  });

  it('dequeueForEdit ignores unknown ids and leaves the queue untouched', () => {
    const { result } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('only');
    });

    let removed: QueuedMessage | undefined;
    act(() => {
      removed = result.current.queueApi.dequeueForEdit('unknown-id');
    });

    expect(removed).toBeUndefined();
    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['only']);
  });

  it('dequeueForEdit sees the order applied by reorder', () => {
    const { result } = renderQueue(true);

    let removed: QueuedMessage | undefined;
    act(() => {
      result.current.queueApi.enqueue('first');
      result.current.queueApi.enqueue('second');
    });
    const [a, b] = result.current.queueApi.queue;
    act(() => {
      result.current.queueApi.reorder([b.id, a.id]);
      removed = result.current.queueApi.dequeueForEdit(b.id);
    });

    expect(removed).toMatchObject({ content: 'second' });
    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['first']);
  });

  it('peekQueuedMessage does not remove and reports unknown ids', () => {
    const { result } = renderQueue(true);

    let peeked: QueuedMessage | undefined;
    act(() => {
      result.current.queueApi.enqueue('stays');
      peeked = result.current.queueApi.peekQueuedMessage('unknown-id');
    });

    expect(peeked).toBeUndefined();
    expect(result.current.queueApi.queue.map(m => m.content)).toEqual(['stays']);
  });

  it('does not execute a message taken out of the queue for editing', () => {
    const { result, onExecute } = renderQueue(true);

    act(() => {
      result.current.queueApi.enqueue('kept for later');
      result.current.queueApi.enqueue('edit me');
    });
    act(() => {
      result.current.queueApi.dequeueForEdit(result.current.queueApi.queue[1].id);
    });
    act(() => {
      result.current.setLoading(false);
    });

    expect(onExecute).toHaveBeenCalledExactlyOnceWith('kept for later', undefined);
  });

  it('never dispatches a message taken for editing just as the turn ended', () => {
    // A click can land after the idle render commits but before its passive
    // effects run; a layout effect fires in exactly that window.
    const onExecute = vi.fn();
    const taken: Array<QueuedMessage | undefined> = [];
    const { result, rerender } = renderHook(({ isLoading }: { isLoading: boolean }) => {
      const queueApi = useMessageQueue({ isLoading, onExecute });
      const { queue, dequeueForEdit } = queueApi;
      useLayoutEffect(() => {
        if (!isLoading && taken.length === 0 && queue.length > 0) {
          taken.push(dequeueForEdit(queue[0].id));
        }
      }, [isLoading, queue, dequeueForEdit]);
      return queueApi;
    }, { initialProps: { isLoading: true } });

    act(() => {
      result.current.enqueue('edit me');
      result.current.enqueue('send me');
    });
    rerender({ isLoading: false });

    // The edited message is in the draft now, so sending it too would send it twice.
    expect(taken.map(message => message?.content)).toEqual(['edit me']);
    expect(onExecute).toHaveBeenCalledExactlyOnceWith('send me', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('sends the quotes of a queued message even after the input dropped them', () => {
    const { result, onExecute } = renderQueue(true);
    const id = registerQuote('quoted line');
    let sent = '';
    onExecute.mockImplementation((content: string) => {
      sent = expandQuoteTokens(content);
    });

    act(() => {
      result.current.queueApi.enqueue(`see ${makeQuoteToken(id)}`);
    });
    // Typing the next message renders the input's tags, which prunes every
    // quote that is not in the input - including the queued one.
    pruneQuoteRegistry(new Set());
    act(() => {
      result.current.setLoading(false);
    });

    expect(sent).toBe('see > quoted line\n');
  });

  it('hands the quote text over with a message taken for editing', () => {
    const { result } = renderQueue(true);
    const id = registerQuote('quoted line');

    act(() => {
      result.current.queueApi.enqueue(`see ${makeQuoteToken(id)}`);
      result.current.queueApi.enqueue('no quote here');
    });
    const [quoted, plain] = result.current.queueApi.queue;

    expect(quoted.quotes).toEqual({ [id]: 'quoted line' });
    expect(plain).not.toHaveProperty('quotes');
  });
});
