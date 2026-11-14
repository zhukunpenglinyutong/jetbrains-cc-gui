import { StrictMode, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { ATTACHMENTS_DRAFT_KEY, useAttachmentPersistence } from './useAttachmentPersistence.js';

const screenshot: Attachment = {
  id: 'screenshot', fileName: 'shot.png', mediaType: 'image/png', data: 'aW1hZ2U=',
};

function useDraft(isControlled = false) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const persistence = useAttachmentPersistence({ attachments, isControlled, onRestore: setAttachments });
  return { attachments, setAttachments, ...persistence };
}

describe('useAttachmentPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('ignores legacy shared drafts whose owning webview is unknown', () => {
    localStorage.setItem(ATTACHMENTS_DRAFT_KEY, JSON.stringify([screenshot]));

    const { result } = renderHook(() => useDraft());

    expect(result.current.attachments).toEqual([]);
    expect(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBeNull();
  });

  it('saves only to the webview session and restores on input remount in StrictMode', () => {
    const first = renderHook(() => useDraft(), { wrapper: StrictMode });
    act(() => first.result.current.setAttachments([screenshot]));
    expect(JSON.parse(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)!)).toEqual([screenshot]);
    expect(localStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBeNull();
    first.unmount();

    const restored = renderHook(() => useDraft(), { wrapper: StrictMode });
    expect(restored.result.current.attachments).toEqual([screenshot]);
  });

  it.each(['remove', 'submit'] as const)('does not restore a draft after %s', (action) => {
    const first = renderHook(() => useDraft());
    act(() => first.result.current.setAttachments([screenshot]));
    act(() => {
      if (action === 'remove') first.result.current.setAttachments([]);
      else first.result.current.clearDraft();
    });
    first.unmount();

    expect(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBeNull();
    expect(renderHook(() => useDraft()).result.current.attachments).toEqual([]);
  });

  it('leaves externally controlled attachments and their persistence to the parent', () => {
    const serialized = JSON.stringify([screenshot]);
    sessionStorage.setItem(ATTACHMENTS_DRAFT_KEY, serialized);
    const { result } = renderHook(() => useDraft(true));
    expect(result.current.attachments).toEqual([]);
    act(() => result.current.setAttachments([{ ...screenshot, id: 'controlled' }]));
    expect(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBe(serialized);
  });

  it.each(['{broken', '{}'])('discards a corrupted session draft: %s', (stored) => {
    sessionStorage.setItem(ATTACHMENTS_DRAFT_KEY, stored);
    expect(renderHook(() => useDraft()).result.current.attachments).toEqual([]);
    expect(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBeNull();
  });

  it('filters malformed attachments when restoring', () => {
    sessionStorage.setItem(ATTACHMENTS_DRAFT_KEY, JSON.stringify([screenshot, null, { id: 'invalid' }]));
    expect(renderHook(() => useDraft()).result.current.attachments).toEqual([screenshot]);
  });

  it('restores and clears an existing draft even when storage has no space for new writes', () => {
    const serialized = JSON.stringify([screenshot]);
    sessionStorage.setItem(ATTACHMENTS_DRAFT_KEY, serialized);
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError');
    });

    const { result } = renderHook(() => useDraft());
    expect(result.current.attachments).toEqual([screenshot]);
    expect(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBe(serialized);
    act(() => result.current.clearDraft());
    expect(sessionStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBeNull();
  });

  it.each(['size limit', 'storage quota'] as const)('does not resurrect an older draft after hitting the %s', (limit) => {
    const first = renderHook(() => useDraft());
    act(() => first.result.current.setAttachments([screenshot]));
    if (limit === 'storage quota') {
      vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('Storage is full', 'QuotaExceededError');
      });
    }
    const replacement = {
      ...screenshot,
      id: 'replacement',
      data: limit === 'size limit' ? 'A'.repeat(2 * 1024 * 1024) : 'bmV3',
    };
    act(() => first.result.current.setAttachments([replacement]));
    expect(first.result.current.attachments).toEqual([replacement]);
    first.unmount();
    vi.restoreAllMocks();

    expect(renderHook(() => useDraft()).result.current.attachments).toEqual([]);
  });

  it('keeps attachments usable when session storage is unavailable without using shared storage', () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError');
    });
    const { result } = renderHook(() => useDraft());
    act(() => result.current.setAttachments([screenshot]));
    act(() => result.current.saveDraft());
    act(() => result.current.clearDraft());
    expect(result.current.attachments).toEqual([screenshot]);
    expect(localStorage.getItem(ATTACHMENTS_DRAFT_KEY)).toBeNull();
  });
});
