import type { Attachment } from '../components/ChatInputBox/types';
import { restoreQuotes } from '../components/ChatInputBox/utils/quoteRegistry';
import type { QueuedMessage } from './useMessageQueue';

/** Zero-width and BOM characters that JCEF can leave behind in a visually empty editor. */
const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;

/** Input-draft payload produced when a queued message is edited */
export interface QueuedDraftRestore {
  /** Content to write back into the input draft */
  content: string;
  /** Attachments to restore on the input draft */
  attachments: Attachment[];
  /** True when a non-empty draft was kept and the queued message was merged into it */
  merged: boolean;
}

/**
 * The draft surface a queued message is restored into.
 *
 * Structurally satisfied by `ChatInputBoxHandle`, but kept narrow so the
 * restore flow can be exercised without rendering the input box.
 */
export interface QueuedDraftTarget {
  getValue: () => string;
  getAttachments: () => Attachment[];
  setValue: (content: string) => void;
  /** Returns false when the target cannot take the attachments (externally controlled) */
  setAttachments: (attachments: Attachment[]) => boolean;
  /**
   * Capability probe for the step above: false means no attachment can ever be
   * restored, so an edit that would drop them is refused up front. Targets that
   * do not implement it are treated as capable.
   */
  canApplyAttachments?: () => boolean;
  /**
   * True while a pasted image is still on its way into the draft. Writing the
   * draft cancels that paste, so the edit waits instead. Absent means none.
   */
  hasPendingImagePastes?: () => boolean;
  focus: () => void;
}

export interface QueuedDraftWrite extends QueuedDraftRestore {
  /** False when the target refused the attachments, so the caller can warn the user */
  attachmentsApplied: boolean;
  /** How many attachments the queued message itself carried */
  queuedAttachmentCount: number;
}

/** Queue access needed by the edit flow: look first, remove only when it is safe. */
export interface QueuedEditSource {
  /** Read a queued message without removing it */
  peek: (id: string) => QueuedMessage | undefined;
  /** Remove a queued message and hand it over */
  take: (id: string) => QueuedMessage | undefined;
}

/**
 * Outcome of an attempt to edit a queued message.
 *
 * Everything but `restored` leaves the queue and the draft untouched, so the
 * caller can report the reason without having to put anything back.
 */
export type QueuedEditResult =
  | { status: 'restored'; write: QueuedDraftWrite }
  /** No input to restore into: dequeuing would drop the message for good. */
  | { status: 'no-target' }
  /** The id is unknown (already sent, or already edited). */
  | { status: 'not-found' }
  /** The target cannot take attachments, so the message stays queued. */
  | { status: 'attachments-blocked' }
  /** A pasted image has not reached the draft yet; writing now would drop it. */
  | { status: 'images-pending' };

/**
 * Build the input-draft payload for editing a queued message.
 *
 * The queued message is restored as if it had never been sent. When the input
 * already holds unsent content or attachments, nothing is overwritten: the
 * queued message is appended after the current draft text and its attachments
 * are merged in (deduplicated by id).
 */
export function mergeQueuedMessageIntoDraft(
  current: { content: string; attachments: Attachment[] },
  queued: { content: string; attachments?: Attachment[] },
): QueuedDraftRestore {
  const hasCurrentContent = current.content.replace(INVISIBLE_CHARS_RE, '').trim().length > 0;
  const content = hasCurrentContent
    ? `${current.content.replace(/\s+$/, '')}\n\n${queued.content}`
    : queued.content;
  const seen = new Set(current.attachments.map(attachment => attachment.id));
  const attachments = [...current.attachments];
  for (const attachment of queued.attachments ?? []) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    attachments.push(attachment);
  }
  return {
    content,
    attachments,
    merged: hasCurrentContent || current.attachments.length > 0,
  };
}

/**
 * Write a queued message back into the draft: merge it with whatever the draft
 * already holds, then apply content and attachments to the target.
 */
export function writeQueuedMessageToDraft(
  target: QueuedDraftTarget,
  queued: QueuedMessage,
): QueuedDraftWrite {
  const restored = mergeQueuedMessageIntoDraft(
    { content: target.getValue(), attachments: target.getAttachments() },
    { content: queued.content, attachments: queued.attachments },
  );
  // setValue renders the quote chips, so their text has to be registered first.
  restoreQuotes(queued.quotes);
  target.setValue(restored.content);
  const attachmentsApplied = target.setAttachments(restored.attachments);
  target.focus();
  return {
    ...restored,
    attachmentsApplied,
    queuedAttachmentCount: queued.attachments?.length ?? 0,
  };
}

/**
 * Take a queued message out of the queue and restore it into the draft.
 *
 * Nothing is removed until the restore is known to be safe: without a draft to
 * restore into, or when the target cannot take the message's attachments,
 * dequeuing would drop the message for good, and while an image paste is still
 * landing, writing the draft would drop that image.
 */
export function takeQueuedMessageForEdit(
  target: QueuedDraftTarget | null | undefined,
  source: QueuedEditSource,
  id: string,
): QueuedEditResult {
  if (!target) return { status: 'no-target' };
  const queued = source.peek(id);
  if (!queued) return { status: 'not-found' };
  if ((queued.attachments?.length ?? 0) > 0 && target.canApplyAttachments?.() === false) {
    return { status: 'attachments-blocked' };
  }
  if (target.hasPendingImagePastes?.() === true) return { status: 'images-pending' };
  const removed = source.take(id);
  if (!removed) return { status: 'not-found' };
  return { status: 'restored', write: writeQueuedMessageToDraft(target, removed) };
}
