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
    const container = document.getElementById('ccgui-markdown-review');
    if (container) container.remove();
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
