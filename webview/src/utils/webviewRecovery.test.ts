import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_FLUSH_EVENT, mirrorDraft } from '../contexts/draftStorage';
import { ATTACHMENTS_DRAFT_KEY } from '../components/ChatInputBox/hooks/useAttachmentPersistence';
import { readDialogDraft, writeDialogDraft } from './dialogStateStorage';
import {
  cancelWebviewRecovery, prepareWebviewRecovery, pruneClosedRecoveryCheckpoints, restoreWebviewRecovery,
} from './webviewRecovery';

const key = 'installation:project:tab-one';
const storageKey = 'ccgui-browser-recovery:' + key;
const attachment = { id: 'image-1', fileName: 'image.png', mediaType: 'image/png', data: 'aGVsbG8=' };
const flush = () => mirrorDraft('最新草稿\n@src/main.go');

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  localStorage.clear();
  window.__CCGUI_DRAFT_CACHE_KEY__ = key;
  document.body.innerHTML = '<div class="input-editable" contenteditable="true"></div>';
  document.body.inert = false;
  window.name = '';
  window.addEventListener(DRAFT_FLUSH_EVENT, flush);
});

afterEach(() => {
  cancelWebviewRecovery('recover-one');
  cancelWebviewRecovery('recover-two');
  window.removeEventListener(DRAFT_FLUSH_EVENT, flush);
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete window.__CCGUI_DRAFT_CACHE_KEY__;
});

describe('native view recovery checkpoints', () => {
  it('flushes pending text and restores text plus images after the old sessionStorage disappears', () => {
    sessionStorage.setItem(ATTACHMENTS_DRAFT_KEY, JSON.stringify([attachment]));
    document.body.insertAdjacentHTML('beforeend', '<div class="attachment-item"></div>');
    expect(prepareWebviewRecovery('recover-one')).toEqual({ requestId: 'recover-one', success: true });
    expect(document.body.inert).toBe(true);
    // Closing a native browser destroys its sessionStorage, but retains the scoped checkpoint.
    sessionStorage.clear();
    restoreWebviewRecovery();
    expect(JSON.parse(sessionStorage.getItem('ccgui-draft:' + key)!)).toMatchObject({ text: '最新草稿\n@src/main.go' });
    expect(JSON.parse(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)!)).toEqual([attachment]);
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('does not restore one tab into another tab or installation', () => {
    prepareWebviewRecovery('recover-one');
    sessionStorage.clear();
    window.__CCGUI_DRAFT_CACHE_KEY__ = 'other-installation:project:tab-one';
    restoreWebviewRecovery();
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.getItem(storageKey)).not.toBeNull();
  });

  it('preserves pending dialog input without transferring unrelated session data', () => {
    writeDialogDraft('askUserQuestion', 'question', { dialogToken: 'question-token', deadlineMs: 42, answer: '尚未提交的回答' });
    sessionStorage.setItem('unrelated-session-state', 'not-a-chat-draft');
    prepareWebviewRecovery('recover-one');
    sessionStorage.clear();
    restoreWebviewRecovery();
    expect(readDialogDraft('askUserQuestion', 'question', 42, 'question-token'))
      .toMatchObject({ answer: '尚未提交的回答' });
    expect(readDialogDraft('askUserQuestion', 'question', 42, 'another-token')).toBeNull();
    expect(sessionStorage.getItem('unrelated-session-state')).toBeNull();
  });

  it('retains the same-window dialog fallback used by opaque JCEF documents', () => {
    const fallback = 'ccgui.dialog-drafts:' + JSON.stringify({ 'ccgui.dialog-draft.permission.token': '{"message":"draft"}' });
    window.name = fallback;
    prepareWebviewRecovery('recover-one');
    window.name = '';
    sessionStorage.clear();
    restoreWebviewRecovery();
    expect(window.name).toBe(fallback);
  });

  it('refuses recovery while an input hook is composing or waiting to restore its draft', () => {
    const composing = (event: Event) => event.preventDefault();
    window.addEventListener(DRAFT_FLUSH_EVENT, composing);
    try {
      expect(prepareWebviewRecovery('recover-one').success).toBe(false);
      expect(document.body.inert).toBe(false);
      expect(localStorage.getItem(storageKey)).toBeNull();
    } finally { window.removeEventListener(DRAFT_FLUSH_EVENT, composing); }
  });

  it('refuses replacement when an attachment could not be persisted', () => {
    document.body.insertAdjacentHTML('beforeend', '<div class="attachment-item"></div>');
    expect(prepareWebviewRecovery('recover-one').success).toBe(false);
    expect(document.body.inert).toBe(false);
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  it('keeps the current view usable when client storage is full', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(prepareWebviewRecovery('recover-one').success).toBe(false);
    expect(document.body.inert).toBe(false);
  });

  it('keeps the checkpoint if the replacement browser cannot restore it', () => {
    prepareWebviewRecovery('recover-one');
    sessionStorage.clear();
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    expect(() => restoreWebviewRecovery()).toThrow();
    expect(localStorage.getItem(storageKey)).not.toBeNull();
  });

  it('unlocks the old page if Java does not acknowledge the request', () => {
    prepareWebviewRecovery('recover-one');
    vi.advanceTimersByTime(6000);
    expect(document.body.inert).toBe(false);
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('ccgui-draft:' + key)!).text).toBe('最新草稿\n@src/main.go');
  });

  it('coalesces duplicate native clicks and ignores a stale cancellation', () => {
    expect(prepareWebviewRecovery('recover-one').success).toBe(true);
    expect(prepareWebviewRecovery('recover-two').success).toBe(false);
    cancelWebviewRecovery('recover-one');
    expect(prepareWebviewRecovery('recover-two').success).toBe(true);
    cancelWebviewRecovery('recover-one');
    expect(document.body.inert).toBe(true);
    expect(JSON.parse(localStorage.getItem(storageKey)!).requestId).toBe('recover-two');
  });

  it('preserves an empty input without reviving old attachments', () => {
    window.removeEventListener(DRAFT_FLUSH_EVENT, flush);
    mirrorDraft('');
    prepareWebviewRecovery('recover-one');
    sessionStorage.setItem(ATTACHMENTS_DRAFT_KEY, JSON.stringify([attachment]));
    restoreWebviewRecovery();
    expect(JSON.parse(sessionStorage.getItem('ccgui-draft:' + key)!).text).toBe('');
    expect(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBeNull();
  });

  it('does not overwrite a failed restore checkpoint with an empty input', () => {
    prepareWebviewRecovery('recover-one');
    cancelWebviewRecovery('recover-one');
    localStorage.setItem(storageKey, 'original-checkpoint');
    document.body.innerHTML = '<div data-ccgui-recovery-failed="true"></div>';
    expect(prepareWebviewRecovery('recover-two').success).toBe(false);
    expect(localStorage.getItem(storageKey)).toBe('original-checkpoint');
  });

  it('prunes abandoned copies only within the host scope confirmed by Java', () => {
    localStorage.setItem(storageKey, 'open');
    localStorage.setItem('ccgui-browser-recovery:installation:project:closed', 'closed');
    localStorage.setItem('ccgui-browser-recovery:other:project:closed', 'other-host');
    pruneClosedRecoveryCheckpoints('installation:', [key]);
    expect(localStorage.getItem(storageKey)).toBe('open');
    expect(localStorage.getItem('ccgui-browser-recovery:installation:project:closed')).toBeNull();
    expect(localStorage.getItem('ccgui-browser-recovery:other:project:closed')).toBe('other-host');
  });
});
