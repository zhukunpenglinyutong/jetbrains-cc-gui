import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('native Markdown settings workflow and runtime toggle', () => {
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
    previewRoot.innerHTML = '<p data-sourcepos="0..50">第一段测试文本</p><p data-sourcepos="50..100">第二段测试文本</p>';
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

  it('hides container and drops temporary state when disabled frame arrives', async () => {
    await import('./index');
    expect(messageCallback).toBeTypeOf('function');
    expect(sentMessages.some(m => m.data.includes('"action":"ready"'))).toBe(true);

    const container = document.getElementById('ccgui-markdown-review');
    expect(container).not.toBeNull();

    // 1. Initial frame: disabled
    messageCallback!(JSON.stringify({
      kind: 'state',
      panelId: 'panel-1',
      documentVersion: 1,
      enabled: false,
      annotations: [],
    }));

    // Entire review overlay is hidden when disabled
    expect(container!.hidden).toBe(true);

    // 2. Setting enabled frame arrives with 1 annotation
    messageCallback!(JSON.stringify({
      kind: 'state',
      panelId: 'panel-1',
      documentVersion: 2,
      enabled: true,
      language: 'zh',
      annotations: [
        { id: 'ann-1', revision: 1, start: 0, end: 10, selectedText: '第一段', comment: '测试批注', status: 'attached' },
      ],
    }));

    expect(container!.hidden).toBe(false);
    expect(container!.lang).toBe('zh');
    const controls = container!.querySelector('.ccgui-md-controls');
    expect(controls).not.toBeNull();
    // Buttons for count and transfer must be rendered and localized
    expect(controls!.textContent).toContain('1 条批注');

    // 3. Runtime disable: user turns setting off while overlay was visible
    messageCallback!(JSON.stringify({
      kind: 'state',
      panelId: 'panel-1',
      documentVersion: 3,
      enabled: false,
      annotations: [],
    }));

    expect(container!.hidden).toBe(true);
    const popup = container!.querySelector('.ccgui-md-popup');
    expect(popup?.children.length ?? 0).toBe(0);
    const highlights = container!.querySelector('.ccgui-md-highlights');
    expect(highlights?.children.length ?? 0).toBe(0);
  });

  it('suppresses sync notifications after native render patch when disabled', async () => {
    await import('./index');
    expect(messageCallback).toBeTypeOf('function');
    const win = window as any;
    const afterPatch = win.IncrementalDOM.notifications.afterPatchListeners[0];
    expect(afterPatch).toBeDefined();

    // Set state to disabled
    messageCallback!(JSON.stringify({
      kind: 'state',
      panelId: 'panel-1',
      documentVersion: 1,
      enabled: false,
      annotations: [],
    }));

    sentMessages.length = 0;
    afterPatch();
    vi.advanceTimersByTime(200);

    // No sync should be dispatched
    const hasSync = sentMessages.some(m => m.data.includes('"action":"sync"'));
    expect(hasSync).toBe(false);

    // Now re-enable
    messageCallback!(JSON.stringify({
      kind: 'state',
      panelId: 'panel-1',
      documentVersion: 2,
      enabled: true,
      annotations: [],
    }));

    sentMessages.length = 0;
    afterPatch();
    // Before 120ms debounce: no sync
    expect(sentMessages.some(m => m.data.includes('"action":"sync"'))).toBe(false);
    // After 120ms debounce: sync sent exactly once
    vi.advanceTimersByTime(130);
    const syncMessages = sentMessages.filter(m => m.data.includes('"action":"sync"'));
    expect(syncMessages).toHaveLength(1);
  });
});
