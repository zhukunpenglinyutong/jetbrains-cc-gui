import { DRAFT_FLUSH_EVENT, draftCacheKey } from '../contexts/draftStorage';
import { ATTACHMENTS_DRAFT_KEY } from '../components/ChatInputBox/hooks/useAttachmentPersistence';
import type { Attachment } from '../components/ChatInputBox/types';

const PREFIX = 'ccgui-browser-recovery:';
const UNLOCK_TIMEOUT_MS = 6000;
const DIALOG_PREFIX = 'ccgui.dialog-draft.';
const DIALOG_WINDOW_PREFIX = 'ccgui.dialog-drafts:';

interface Checkpoint {
  version: 1;
  requestId: string;
  key: string;
  text: string;
  attachments: Attachment[];
  savedAt: number;
  dialogs?: Record<string, string>;
  dialogWindowName?: string;
}

export interface RecoveryAcknowledgement {
  requestId: string;
  success: boolean;
}

let prepared: { requestId: string; storageKey: string; previousInert: boolean; timer: number } | null = null;

function validAttachments(value: unknown): value is Attachment[] {
  return Array.isArray(value) && value.every((item) => item &&
    ['id', 'fileName', 'mediaType', 'data'].every((key) => typeof item[key] === 'string'));
}

/** Release only this attempt; an old timeout must never remove a newer checkpoint. */
export function cancelWebviewRecovery(requestId: string): void {
  if (!prepared || prepared.requestId !== requestId) return;
  const current = prepared;
  prepared = null;
  window.clearTimeout(current.timer);
  document.body.inert = current.previousInert;
  try { localStorage.removeItem(current.storageKey); } catch { /* Keep the old page usable. */ }
}

/**
 * Native views can stop painting while JS stays healthy. Preserve the input within the client
 * before Java replaces that view; draft text and image data never travel through the bridge.
 */
export function prepareWebviewRecovery(requestId: string): RecoveryAcknowledgement {
  const failed = { requestId, success: false };
  if (prepared || document.querySelector('[data-ccgui-recovery-failed]')
      || !/^[a-zA-Z0-9-]{1,80}$/.test(requestId)) return failed;
  let storageKey: string | null = null;
  try {
    const key = draftCacheKey();
    if (!key || !window.dispatchEvent(new Event(DRAFT_FLUSH_EVENT, { cancelable: true }))) return failed;
    const draft = JSON.parse(sessionStorage.getItem('ccgui-draft:' + key) || 'null');
    if (typeof draft?.text !== 'string') return failed;
    const attachments: unknown = JSON.parse(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY) || '[]');
    if (!validAttachments(attachments)
        || (document.querySelector('.input-editable')
          && attachments.length !== document.querySelectorAll('.attachment-item').length)) return failed;

    // Pending question/permission input also belongs to this view. Transfer only app draft keys.
    const dialogs = Object.fromEntries(Object.keys(sessionStorage)
      .filter((name) => name.startsWith(DIALOG_PREFIX))
      .map((name) => [name, sessionStorage.getItem(name)!]));
    const checkpoint: Checkpoint = {
      version: 1, requestId, key, text: draft.text, attachments, savedAt: Date.now(), dialogs,
      dialogWindowName: window.name.startsWith(DIALOG_WINDOW_PREFIX) ? window.name : undefined,
    };
    storageKey = PREFIX + key;
    const serialized = JSON.stringify(checkpoint);
    // sessionStorage disappears with the old browser. This one-use copy survives recreation,
    // is scoped to the installation/project/window key, and is removed before normal editing.
    localStorage.setItem(storageKey, serialized);
    if (localStorage.getItem(storageKey) !== serialized) throw new Error('Checkpoint write failed');
    const previousInert = document.body.inert;
    const timer = window.setTimeout(() => cancelWebviewRecovery(requestId), UNLOCK_TIMEOUT_MS);
    prepared = { requestId, storageKey, previousInert, timer };
    document.body.inert = true;
    return { requestId, success: true };
  } catch {
    if (storageKey) {
      try { localStorage.removeItem(storageKey); } catch { /* The source view remains intact. */ }
    }
    return failed;
  }
}

/** Restore synchronously before React mounts; normal startup only performs one scoped key lookup. */
export function restoreWebviewRecovery(): void {
  const key = draftCacheKey();
  if (!key) return;
  let raw: string | null;
  try { raw = localStorage.getItem(PREFIX + key); } catch { return; }
  if (raw === null) return;
  const checkpoint = JSON.parse(raw) as Checkpoint;
  if (checkpoint.version !== 1 || checkpoint.key !== key || typeof checkpoint.text !== 'string'
      || !Number.isFinite(checkpoint.savedAt) || !validAttachments(checkpoint.attachments)
      || (checkpoint.dialogs !== undefined && (!checkpoint.dialogs || typeof checkpoint.dialogs !== 'object'
        || Object.entries(checkpoint.dialogs).some(([name, value]) => !name.startsWith(DIALOG_PREFIX) || typeof value !== 'string')))
      || (checkpoint.dialogWindowName !== undefined && (typeof checkpoint.dialogWindowName !== 'string'
        || !checkpoint.dialogWindowName.startsWith(DIALOG_WINDOW_PREFIX)))) {
    throw new Error('Invalid recovery checkpoint');
  }
  const draftKey = 'ccgui-draft:' + key;
  const draft = JSON.stringify({ text: checkpoint.text, savedAt: checkpoint.savedAt });
  const attachments = JSON.stringify(checkpoint.attachments);
  sessionStorage.setItem(draftKey, draft);
  if (checkpoint.attachments.length) sessionStorage.setItem(ATTACHMENTS_DRAFT_KEY, attachments);
  else sessionStorage.removeItem(ATTACHMENTS_DRAFT_KEY);
  if (sessionStorage.getItem(draftKey) !== draft
      || (checkpoint.attachments.length && sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY) !== attachments)) {
    throw new Error('Recovery checkpoint could not be restored');
  }
  for (const [name, value] of Object.entries(checkpoint.dialogs ?? {})) {
    sessionStorage.setItem(name, value);
    if (sessionStorage.getItem(name) !== value) throw new Error('Dialog draft could not be restored');
  }
  if (checkpoint.dialogWindowName !== undefined) window.name = checkpoint.dialogWindowName;
  localStorage.removeItem(PREFIX + key);
}

/** Discard abandoned checkpoints only for windows Java confirms closed in this installation. */
export function pruneClosedRecoveryCheckpoints(scope: string, open: string[]): void {
  if (!scope) return;
  try {
    const allowed = new Set([...open, draftCacheKey()].filter(Boolean).map((key) => PREFIX + key));
    const closed = Object.keys(localStorage).filter((key) => key.startsWith(PREFIX + scope) && !allowed.has(key));
    closed.forEach((key) => localStorage.removeItem(key));
  } catch { /* Storage access cannot interrupt the chat. */ }
}
