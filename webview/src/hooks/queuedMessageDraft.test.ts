import { describe, expect, it, vi } from 'vitest';
import {
  mergeQueuedMessageIntoDraft,
  takeQueuedMessageForEdit,
  writeQueuedMessageToDraft,
} from './queuedMessageDraft';
import type { QueuedDraftTarget } from './queuedMessageDraft';
import type { QueuedMessage } from './useMessageQueue';
import type { Attachment } from '../components/ChatInputBox/types';
import { getQuote, makeQuoteToken, pruneQuoteRegistry, registerQuote } from '../components/ChatInputBox/utils/quoteRegistry';

const attachment: Attachment = { id: 'att-1', fileName: 'notes.txt', mediaType: 'text/plain', data: 'aGk=' };
const queuedAttachment: Attachment = { id: 'att-2', fileName: 'pic.png', mediaType: 'image/png', data: 'aW1n' };

const queuedMessage = (overrides: Partial<QueuedMessage> = {}): QueuedMessage => ({
  id: 'queue-1',
  content: 'queued message',
  queuedAt: 1,
  ...overrides,
});

/**
 * Records every write the restore flow performs, in order, so the tests can
 * assert both the payload and the sequence (content before attachments before
 * focus - the input renders the chips on setValue, and focus is what keeps the
 * controlled-value sync from rewriting the DOM afterwards).
 */
function createTarget(options: {
  content?: string;
  attachments?: Attachment[];
  acceptsAttachments?: boolean;
  pendingImages?: boolean;
} = {}) {
  const calls: string[] = [];
  const state = {
    content: options.content ?? '',
    attachments: options.attachments ?? [],
  };
  const target: QueuedDraftTarget = {
    getValue: () => state.content,
    getAttachments: () => state.attachments,
    setValue: vi.fn((next: string) => {
      calls.push('setValue');
      state.content = next;
    }),
    setAttachments: vi.fn((next: Attachment[]) => {
      calls.push('setAttachments');
      if (options.acceptsAttachments === false) return false;
      state.attachments = next;
      return true;
    }),
    canApplyAttachments: () => options.acceptsAttachments !== false,
    hasPendingImagePastes: () => options.pendingImages === true,
    focus: vi.fn(() => {
      calls.push('focus');
    }),
  };
  return { target, state, calls };
}

/** Minimal queue the edit flow reads from and removes messages from. */
function createSource(messages: QueuedMessage[]) {
  const items = [...messages];
  return {
    source: {
      peek: vi.fn((id: string) => items.find(item => item.id === id)),
      take: vi.fn((id: string) => {
        const index = items.findIndex(item => item.id === id);
        if (index < 0) return undefined;
        return items.splice(index, 1)[0];
      }),
    },
    items,
  };
}

describe('mergeQueuedMessageIntoDraft', () => {
  it('restores the queued message as-is when the input draft is empty', () => {
    const restore = mergeQueuedMessageIntoDraft(
      { content: '   ', attachments: [] },
      { content: 'queued message', attachments: [queuedAttachment] },
    );

    expect(restore).toEqual({ content: 'queued message', attachments: [queuedAttachment], merged: false });
  });

  it('appends the queued message after existing draft text and merges its attachments', () => {
    const restore = mergeQueuedMessageIntoDraft(
      { content: 'unsent draft', attachments: [attachment] },
      { content: 'queued message', attachments: [queuedAttachment] },
    );

    expect(restore.content).toBe('unsent draft\n\nqueued message');
    expect(restore.attachments).toEqual([attachment, queuedAttachment]);
    expect(restore.merged).toBe(true);
  });

  it('trims trailing whitespace from the existing draft before joining', () => {
    const restore = mergeQueuedMessageIntoDraft(
      { content: 'unsent draft \n', attachments: [] },
      { content: 'queued message' },
    );

    expect(restore.content).toBe('unsent draft\n\nqueued message');
    expect(restore.merged).toBe(true);
  });

  it('deduplicates restored attachments by id', () => {
    const restore = mergeQueuedMessageIntoDraft(
      { content: '', attachments: [attachment] },
      { content: 'queued message', attachments: [attachment, queuedAttachment] },
    );

    expect(restore.attachments).toEqual([attachment, queuedAttachment]);
    expect(restore.merged).toBe(true);
  });

  it('treats a draft holding only invisible characters as empty', () => {
    // JCEF can leave zero-width characters behind in a visually empty editor.
    const restore = mergeQueuedMessageIntoDraft(
      { content: '\u200B\uFEFF\n', attachments: [] },
      { content: 'queued message' },
    );

    expect(restore).toEqual({ content: 'queued message', attachments: [], merged: false });
  });

  it('flags a merge when only attachments are staged on the input', () => {
    const restore = mergeQueuedMessageIntoDraft(
      { content: '', attachments: [attachment] },
      { content: 'queued message' },
    );

    expect(restore.content).toBe('queued message');
    expect(restore.attachments).toEqual([attachment]);
    expect(restore.merged).toBe(true);
  });
});

describe('writeQueuedMessageToDraft', () => {
  it('writes content, then attachments, then focuses the input', () => {
    const { target, state, calls } = createTarget();

    const restored = writeQueuedMessageToDraft(target, queuedMessage({ attachments: [queuedAttachment] }));

    expect(calls).toEqual(['setValue', 'setAttachments', 'focus']);
    expect(state.content).toBe('queued message');
    expect(state.attachments).toEqual([queuedAttachment]);
    expect(restored).toMatchObject({ content: 'queued message', merged: false, attachmentsApplied: true });
  });

  it('merges into an existing draft instead of overwriting it', () => {
    const { target, state } = createTarget({ content: 'unsent draft', attachments: [attachment] });

    const restored = writeQueuedMessageToDraft(target, queuedMessage({ attachments: [queuedAttachment] }));

    expect(state.content).toBe('unsent draft\n\nqueued message');
    expect(state.attachments).toEqual([attachment, queuedAttachment]);
    expect(restored.merged).toBe(true);
  });

  it('reports when the target refused the attachments so the caller can warn', () => {
    const { target, state } = createTarget({ acceptsAttachments: false });

    const restored = writeQueuedMessageToDraft(target, queuedMessage({ attachments: [queuedAttachment] }));

    // The content is still restored, but the attachments are gone.
    expect(state.content).toBe('queued message');
    expect(state.attachments).toEqual([]);
    expect(restored.attachmentsApplied).toBe(false);
    expect(restored.queuedAttachmentCount).toBe(1);
  });

  it('brings back the quotes the input pruned while the message waited', () => {
    const id = registerQuote('quoted line');
    const quotes = { [id]: 'quoted line' };
    pruneQuoteRegistry(new Set());
    const { target } = createTarget();
    let quoteAtWrite: string | undefined;
    target.setValue = vi.fn(() => {
      quoteAtWrite = getQuote(id)?.text;
    });

    writeQueuedMessageToDraft(target, queuedMessage({ content: `see ${makeQuoteToken(id)}`, quotes }));

    // setValue renders the chips, so the quote has to be known before it runs.
    expect(quoteAtWrite).toBe('quoted line');
  });

  it('counts only the queued message attachments', () => {
    const { target } = createTarget({ attachments: [attachment] });

    const restored = writeQueuedMessageToDraft(target, queuedMessage());

    expect(restored.queuedAttachmentCount).toBe(0);
  });
});

describe('takeQueuedMessageForEdit', () => {
  it('dequeues only after the target exists', () => {
    const { source } = createSource([queuedMessage()]);
    const { target } = createTarget();

    expect(takeQueuedMessageForEdit(null, source, 'queue-1')).toEqual({ status: 'no-target' });
    expect(takeQueuedMessageForEdit(undefined, source, 'queue-1')).toEqual({ status: 'no-target' });
    // Without a draft to restore into, dequeuing would lose the message.
    expect(source.take).not.toHaveBeenCalled();

    const outcome = takeQueuedMessageForEdit(target, source, 'queue-1');

    expect(source.take).toHaveBeenCalledExactlyOnceWith('queue-1');
    expect(outcome.status).toBe('restored');
    expect(outcome).toMatchObject({ write: { content: 'queued message' } });
  });

  it('leaves the queue alone when the message is already gone', () => {
    const { source } = createSource([]);
    const { target } = createTarget();

    expect(takeQueuedMessageForEdit(target, source, 'missing')).toEqual({ status: 'not-found' });
    expect(target.setValue).not.toHaveBeenCalled();
    expect(target.focus).not.toHaveBeenCalled();
  });

  it('keeps the message queued when its attachments could never be restored', () => {
    const { source, items } = createSource([queuedMessage({ attachments: [queuedAttachment] })]);
    const { target, state } = createTarget({ acceptsAttachments: false });

    const outcome = takeQueuedMessageForEdit(target, source, 'queue-1');

    // Refused before anything is removed, so the message is still queued and
    // the draft was never touched.
    expect(outcome).toEqual({ status: 'attachments-blocked' });
    expect(items).toHaveLength(1);
    expect(source.take).not.toHaveBeenCalled();
    expect(state.content).toBe('');
  });

  it('keeps the message queued while an image is still being added to the draft', () => {
    const { source, items } = createSource([queuedMessage()]);
    const { target, state } = createTarget({ pendingImages: true });

    const outcome = takeQueuedMessageForEdit(target, source, 'queue-1');

    // Writing the draft now would cancel that paste and lose the image.
    expect(outcome).toEqual({ status: 'images-pending' });
    expect(items).toHaveLength(1);
    expect(source.take).not.toHaveBeenCalled();
    expect(target.setValue).not.toHaveBeenCalled();
    expect(state.content).toBe('');
  });

  it('still restores a message without attachments to a target that refuses them', () => {
    const { source, items } = createSource([queuedMessage()]);
    const { target, state } = createTarget({ acceptsAttachments: false });

    const outcome = takeQueuedMessageForEdit(target, source, 'queue-1');

    expect(outcome.status).toBe('restored');
    expect(items).toHaveLength(0);
    expect(state.content).toBe('queued message');
  });
});
