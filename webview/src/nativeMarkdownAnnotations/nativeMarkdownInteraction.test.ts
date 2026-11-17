import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('native Markdown interaction state machine and debounce', () => {
  let messageCallback: ((data: string) => void) | null = null;
  const sentMessages: Array<{ type: string; data: string }> = [];

  const mockPipe = {
    post: (type: string, data: string) => {
      sentMessages.push({ type, data });
    },
    subscribe: (type: string, callback: (data: string) => void) => {
      if (type === 'ccgui.markdown.response') {
        messageCallback = callback;
      }
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    sentMessages.length = 0;
    messageCallback = null;
    document.body.innerHTML = '';
    document.head.innerHTML = '<meta name="markdown-position-attribute-name" content="data-sourcepos">';

    const previewRoot = document.createElement('div');
    previewRoot.setAttribute('data-sourcepos', '0..100');
    previewRoot.innerHTML = '<p data-sourcepos="0..50">段落内容一</p><p data-sourcepos="50..100">段落内容二</p>';
    document.body.append(previewRoot);

    const win = window as any;
    delete win.__ccguiMarkdownReview;
    win.__IntelliJTools = { messagePipe: mockPipe };
    win.IncrementalDOM = { notifications: { afterPatchListeners: [] } };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.querySelectorAll('#ccgui-markdown-review').forEach(container => container.remove());
    const win = window as any;
    delete win.__ccguiMarkdownReview;
  });

  it('debounces rapid repeated render patches to exactly one sync', async () => {
    await import('./index');
    const win = window as any;
    const afterPatch = win.IncrementalDOM.notifications.afterPatchListeners[0];
    expect(afterPatch).toBeDefined();

    // Enable feature
    messageCallback!(JSON.stringify({
      kind: 'state',
      panelId: 'panel-debounce',
      documentVersion: 1,
      enabled: true,
      annotations: [],
    }));

    sentMessages.length = 0;

    // Simulate 5 rapid keystrokes within 50ms (each firing afterPatch)
    for (let i = 0; i < 5; i++) {
      afterPatch();
      vi.advanceTimersByTime(10);
    }

    // Still within the 120ms debounce window: no sync yet
    expect(sentMessages.filter(m => m.data.includes('"action":"sync"'))).toHaveLength(0);

    // Fast-forward past 120ms
    vi.advanceTimersByTime(120);

    // Exactly 1 sync sent
    const syncs = sentMessages.filter(m => m.data.includes('"action":"sync"'));
    expect(syncs).toHaveLength(1);
  });

  const lastRequest = (action: string) => JSON.parse([...sentMessages].reverse()
    .find(m => m.data.includes(`"action":"${action}"`))!.data);
  const enabledState = (documentVersion: number) => JSON.stringify({
    kind: 'state', panelId: 'panel-1', documentVersion, enabled: true, annotations: [],
  });

  it('does not report a timeout for the first ready that the IDE drops before its pipe exists', async () => {
    // BrowserPipe.js swallows posts until the IDE injects its post function at load end.
    const post = mockPipe.post;
    let connected = false;
    mockPipe.post = (type, data) => { if (connected) post(type, data); };
    try {
      await import('./index');
      connected = true;
      window.dispatchEvent(new Event('IdeReady'));
      messageCallback!(enabledState(1));
      messageCallback!(JSON.stringify({ requestId: lastRequest('ready').requestId, status: 'ok' }));
      vi.advanceTimersByTime(9000);
      expect(document.querySelector('#ccgui-markdown-review .ccgui-md-status')).toBeNull();
    } finally {
      mockPipe.post = post;
    }
  });

  const mockRanges = () => {
    const rect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => rect() as DOMRect);
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [] as unknown as DOMRectList);
  };
  const selectParagraph = () => {
    const text = document.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 2);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  };
  const click = (label: string) => {
    const target = [...document.querySelectorAll<HTMLButtonElement>('#ccgui-markdown-review button')]
      .find(element => element.textContent === label);
    expect(target, label).toBeDefined();
    target!.click();
  };
  const typeCommentAndAdd = (comment: string) => {
    selectParagraph();
    click('Comment');
    const textarea = document.querySelector<HTMLTextAreaElement>('#ccgui-markdown-review textarea')!;
    textarea.value = comment;
    textarea.dispatchEvent(new Event('input'));
    click('Add comment');
  };

  it('keeps a comment the host rejected so the user can select again without retyping it', async () => {
    mockRanges();
    await import('./index');
    messageCallback!(enabledState(1));
    typeCommentAndAdd('tighten this wording');
    // The document changed while typing: the host rejects the stale selection.
    messageCallback!(JSON.stringify({ requestId: lastRequest('create').requestId, status: 'error', messageKey: 'documentChanged' }));
    await vi.waitFor(() => expect(document.querySelector('#ccgui-markdown-review .ccgui-md-popup .primary')).not.toHaveProperty('disabled', true));
    click('Cancel');
    messageCallback!(enabledState(2));
    selectParagraph();
    click('Comment');
    expect(document.querySelector<HTMLTextAreaElement>('#ccgui-markdown-review textarea')!.value).toBe('tighten this wording');
    // A live selection would wake this test's overlay instance during the next test.
    window.getSelection()!.removeAllRanges();
  });

  it('does not carry a timed-out comment to another selection, where it could be created twice', async () => {
    mockRanges();
    await import('./index');
    messageCallback!(enabledState(1));
    typeCommentAndAdd('tighten this wording');
    // No answer within 8 s: the host may still create it.
    vi.advanceTimersByTime(9000);
    await vi.waitFor(() => expect(document.querySelector('#ccgui-markdown-review .ccgui-md-popup .primary')).not.toHaveProperty('disabled', true));
    click('Cancel');
    selectParagraph();
    click('Comment');
    expect(document.querySelector<HTMLTextAreaElement>('#ccgui-markdown-review textarea')!.value).toBe('');
    window.getSelection()!.removeAllRanges();
  });

  it('retries a timed-out comment under its first request id even after a preview sync', async () => {
    mockRanges();
    await import('./index');
    messageCallback!(enabledState(1));
    typeCommentAndAdd('tighten this wording');
    const first = lastRequest('create').requestId;
    vi.advanceTimersByTime(9000);
    await vi.waitFor(() => expect(document.querySelector('#ccgui-markdown-review .ccgui-md-popup .primary')).not.toHaveProperty('disabled', true));
    // The busy IDE re-renders the preview meanwhile; that housekeeping sync must not drop the retry id,
    // or the host could create the comment a second time.
    (window as any).IncrementalDOM.notifications.afterPatchListeners.forEach((listener: () => void) => listener());
    vi.advanceTimersByTime(130);
    expect(lastRequest('sync')).toBeDefined();
    click('Add comment');
    expect(lastRequest('create').requestId).toBe(first);
    window.getSelection()!.removeAllRanges();
  });

  it('filters completed and orphaned annotations from the transfer action', async () => {
    await import('./index');

    messageCallback!(JSON.stringify({
      kind: 'state',
      panelId: 'panel-filter',
      documentVersion: 1,
      enabled: true,
      annotations: [
        { id: 'active-1', revision: 1, start: 0, end: 10, selectedText: '段落', comment: '活跃批注', status: 'attached' },
        { id: 'completed-1', revision: 1, start: 10, end: 20, selectedText: '内容', comment: '已完成批注', status: 'attached', completed: true },
        { id: 'lost-1', revision: 1, start: 20, end: 30, selectedText: '丢失', comment: '原文丢失', status: 'orphaned', sourceMissing: true },
      ],
    }));

    const container = document.getElementById('ccgui-markdown-review');
    const controls = container!.querySelector('.ccgui-md-controls');
    const transferButton = controls!.querySelector('button.primary') as HTMLButtonElement;
    expect(transferButton).not.toBeNull();

    sentMessages.length = 0;
    transferButton.click();

    // Must trigger transfer containing only transferable items ('active-1')
    const transferMsg = sentMessages.find(m => m.data.includes('"action":"transfer"'));
    expect(transferMsg).toBeDefined();
    const payload = JSON.parse(transferMsg!.data);
    expect(payload.annotationIds).toEqual(['active-1']);
  });
});
