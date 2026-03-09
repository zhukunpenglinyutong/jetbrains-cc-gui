import { useCallback, useEffect, useRef } from 'react';
import type { Attachment } from '../types.js';
import { debugLog, debugError } from '../../../utils/debug.js';

/** localStorage key for chat input attachments draft */
export const ATTACHMENTS_DRAFT_KEY = 'chat-input-attachments-draft';

/** Maximum size for serialized attachments draft (2MB) */
const MAX_DRAFT_SIZE = 2097152; // 2 * 1024 * 1024

/**
 * Check if localStorage is available and working
 */
function canUseLocalStorage(): boolean {
  try {
    const testKey = '__localStorage_test__';
    window.localStorage.setItem(testKey, 'test');
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if error is a quota exceeded error
 */
function isQuotaExceededError(err: unknown): boolean {
  const domError = err as { name?: unknown; code?: unknown } | null;
  const name = typeof domError?.name === 'string' ? domError.name : '';
  const code = typeof domError?.code === 'number' ? domError.code : undefined;

  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    code === 22 ||
    code === 1014
  );
}

/**
 * Validate if an object is a valid Attachment
 */
function isValidAttachment(obj: unknown): obj is Attachment {
  if (typeof obj !== 'object' || obj === null) return false;
  const att = obj as Record<string, unknown>;
  return (
    typeof att.id === 'string' &&
    typeof att.fileName === 'string' &&
    typeof att.mediaType === 'string' &&
    typeof att.data === 'string'
  );
}

/**
 * Save attachments draft to localStorage
 * WARNING: Stores base64-encoded image data which can be large.
 * If size exceeds MAX_DRAFT_SIZE, silently skips save to prevent quota errors.
 */
function saveAttachmentsDraft(attachments: Attachment[]): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    if (attachments.length === 0) {
      // If no attachments, remove the draft
      window.localStorage.removeItem(ATTACHMENTS_DRAFT_KEY);
      debugLog('[AttachmentPersistence] Draft cleared');
    } else {
      const serialized = JSON.stringify(attachments);

      // Check size before saving to prevent quota errors
      if (serialized.length > MAX_DRAFT_SIZE) {
        debugError(
          `[AttachmentPersistence] Draft too large (${(serialized.length / 1024).toFixed(1)}KB), ` +
          `max allowed is ${(MAX_DRAFT_SIZE / 1024).toFixed(0)}KB. Skipping save.`
        );
        return;
      }

      window.localStorage.setItem(ATTACHMENTS_DRAFT_KEY, serialized);
      debugLog(`[AttachmentPersistence] Draft saved, count: ${attachments.length}, size: ${(serialized.length / 1024).toFixed(1)}KB`);
    }
  } catch (error) {
    if (isQuotaExceededError(error)) {
      debugError('[AttachmentPersistence] Storage quota exceeded - cannot save attachments. Try removing some images.');
    } else {
      debugError('[AttachmentPersistence] Failed to save draft:', error);
    }
  }
}

/**
 * Load attachments draft from localStorage
 * Validates each attachment structure to prevent crashes from corrupted data
 */
function loadAttachmentsDraft(): Attachment[] {
  if (!canUseLocalStorage()) {
    return [];
  }

  try {
    const stored = window.localStorage.getItem(ATTACHMENTS_DRAFT_KEY);
    if (!stored) {
      return [];
    }

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      debugError('[AttachmentPersistence] Invalid draft format, expected array');
      window.localStorage.removeItem(ATTACHMENTS_DRAFT_KEY);
      return [];
    }

    // Validate each attachment structure
    const validAttachments = parsed.filter((item): item is Attachment => {
      const isValid = isValidAttachment(item);
      if (!isValid) {
        debugError('[AttachmentPersistence] Invalid attachment structure, skipping:', item);
      }
      return isValid;
    });

    if (validAttachments.length < parsed.length) {
      debugError(`[AttachmentPersistence] Skipped ${parsed.length - validAttachments.length} invalid attachments`);
    }

    debugLog('[AttachmentPersistence] Draft loaded, valid count:', validAttachments.length);
    return validAttachments;
  } catch (error) {
    debugError('[AttachmentPersistence] Failed to load draft:', error);
    // Clear corrupted data
    try {
      window.localStorage.removeItem(ATTACHMENTS_DRAFT_KEY);
    } catch {
      // Ignore cleanup errors
    }
    return [];
  }
}

export interface UseAttachmentPersistenceOptions {
  /**
   * Current attachments state
   */
  attachments: Attachment[];
  /**
   * Whether the component is in controlled mode (external attachments)
   * If true, persistence is disabled (parent manages state)
   */
  isControlled: boolean;
  /**
   * Callback to restore attachments from localStorage on mount
   */
  onRestore: (attachments: Attachment[]) => void;
}

export interface UseAttachmentPersistenceReturn {
  /**
   * Save current attachments to localStorage
   */
  saveDraft: () => void;
  /**
   * Clear attachments draft from localStorage
   */
  clearDraft: () => void;
}

/**
 * useAttachmentPersistence - Persist input box attachments to localStorage
 *
 * IMPORTANT: This hook stores attachment metadata AND base64-encoded image data
 * in localStorage, which has limited quota (typically 5-10MB per domain).
 * Large images or multiple attachments may exceed the 2MB limit and fail to persist.
 *
 * Current Limitations:
 * - Max draft size: 2MB (base64 images can be 1-5MB each)
 * - If size exceeds limit, draft is silently skipped (logged to console)
 * - Consider IndexedDB for larger attachments in future
 *
 * Features:
 * - Auto-restore attachments on mount (uncontrolled mode only)
 * - Auto-save on attachments change (via useEffect)
 * - Clear draft when attachments are submitted
 * - Validates attachment structure on load to prevent crashes
 * - Handles localStorage quota errors gracefully
 *
 * This ensures attachments survive page navigation (history/settings view switches).
 * Fixes bug where attachments were lost while text drafts were preserved.
 *
 * @param options.attachments - Current attachments state
 * @param options.isControlled - Whether parent manages attachments (if true, persistence disabled)
 * @param options.onRestore - Callback to restore attachments from localStorage on mount
 * @returns Methods to manually save or clear draft (auto-save is default)
 */
export function useAttachmentPersistence({
  attachments,
  isControlled,
  onRestore,
}: UseAttachmentPersistenceOptions): UseAttachmentPersistenceReturn {
  const isFirstMountRef = useRef(true);
  const prevAttachmentsRef = useRef<Attachment[]>([]);

  // Restore draft on mount (uncontrolled mode only)
  useEffect(() => {
    if (!isFirstMountRef.current) return;
    if (isControlled) return;

    isFirstMountRef.current = false;

    const draft = loadAttachmentsDraft();
    if (draft.length > 0) {
      onRestore(draft);
    }
  }, [isControlled, onRestore]);

  // Auto-save on attachments change (uncontrolled mode only)
  useEffect(() => {
    if (isControlled) return;

    // Skip saving if attachments haven't actually changed (avoid infinite loops)
    const prevAttachments = prevAttachmentsRef.current;
    const hasChanged =
      attachments.length !== prevAttachments.length ||
      attachments.some((att, i) => att.id !== prevAttachments[i]?.id);

    if (!hasChanged) return;

    prevAttachmentsRef.current = attachments;
    saveAttachmentsDraft(attachments);
  }, [attachments, isControlled]);

  // Manual save (for controlled mode or explicit saves)
  const saveDraft = useCallback(() => {
    saveAttachmentsDraft(attachments);
  }, [attachments]);

  // Clear draft (stable reference - no dependencies)
  const clearDraft = useCallback(() => {
    if (canUseLocalStorage()) {
      window.localStorage.removeItem(ATTACHMENTS_DRAFT_KEY);
      debugLog('[AttachmentPersistence] Draft cleared manually');
    }
  }, []);

  return { saveDraft, clearDraft };
}
