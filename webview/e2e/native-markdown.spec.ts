import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/native-markdown.html');
  await expect(page.locator('.ccgui-md-controls')).toBeVisible();
});

test('disables and re-enables annotations without replacing the native preview', async ({ page }) => {
  const original = await page.locator('body > div').first().innerHTML();
  await page.evaluate(() => {
    const native = window as unknown as { __state: { enabled?: boolean }; __response: (raw: string) => void };
    native.__state.enabled = false;
    native.__response(JSON.stringify(native.__state));
  });
  await expect(page.locator('#ccgui-markdown-review')).not.toBeVisible();
  expect(await page.locator('body > div').first().innerHTML()).toBe(original);
  await page.evaluate(() => {
    const native = window as unknown as { __state: { enabled?: boolean }; __response: (raw: string) => void };
    native.__state.enabled = true;
    native.__response(JSON.stringify(native.__state));
  });
  await expect(page.locator('.ccgui-md-controls')).toBeVisible();
});

test('annotates a later native block, edits, transfers and deletes without replacing the renderer', async ({ page }) => {
  await page.evaluate(() => {
    const node = document.querySelectorAll('p')[1].firstChild!;
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 16);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const textarea = page.getByRole('textbox', { name: 'Comment on the selected text' });
  await textarea.fill('测试批注 <script> should stay text');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.getByRole('button', { name: '1 comments', exact: true })).toBeVisible();
  await expect(page.locator('.ccgui-md-marker')).toHaveCount(1);
  await page.locator('.ccgui-md-marker').click();
  await expect(page.locator('.ccgui-md-popup')).toContainText('<script> should stay text');
  const close = page.locator('.ccgui-md-popup-title').getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeVisible();
  await close.click();
  await expect(page.locator('.ccgui-md-popup')).not.toBeVisible();
  await page.locator('.ccgui-md-marker').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await textarea.fill('updated comment');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Add to CC GUI', exact: true }).click();
  await expect(page.locator('.ccgui-md-controls')).toContainText('Review added to the selected chat draft.');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __requests: { action: string }[] }).__requests.map(item => item.action)))
    .toContain('transfer');
  await expect(page.locator('body > div').first().getByRole('heading')).toHaveText('Native preview fixture');
  await page.locator('.ccgui-md-marker').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: '0 comments', exact: true })).toBeVisible();
});

test('quotes directly, keeps edits during a native patch, and restores its overlay', async ({ page }) => {
  const select = () => page.evaluate(() => {
    const node = document.querySelector('strong')!.firstChild!;
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await select();
  await page.getByRole('button', { name: 'Quote to CC GUI', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __requests: { action: string }[] }).__requests.map(item => item.action)))
    .toContain('quote');
  await expect(page.getByRole('button', { name: '0 comments', exact: true })).toBeVisible();
  await select();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const textarea = page.getByRole('textbox');
  await textarea.fill('保留正在编辑的批注');
  await page.evaluate(() => {
    document.querySelector('#ccgui-markdown-review')!.remove();
    const native = window as unknown as { IncrementalDOM: { notifications: { afterPatchListeners: (() => void)[] } } };
    native.IncrementalDOM.notifications.afterPatchListeners.forEach(callback => callback());
  });
  await expect(textarea).toHaveValue('保留正在编辑的批注');
  await expect(page.locator('#ccgui-markdown-review')).toHaveCount(1);
  await textarea.press('Escape');
  await expect(textarea).not.toBeVisible();
});

test('closes the editor when the live comment is removed by a source edit', async ({ page }) => {
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('p')[1].firstChild!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByRole('textbox').fill('Comment removed by source cleanup');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.ccgui-md-marker').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox').fill('Draft while source changes');
  await page.evaluate(() => {
    const native = window as unknown as { __state: { annotations: unknown[] }; __response: (raw: string) => void };
    native.__state.annotations = [];
    native.__response(JSON.stringify(native.__state));
  });
  await expect(page.locator('.ccgui-md-popup')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '0 comments', exact: true })).toBeVisible();
});

test('uses CC GUI language and keeps all popup actions on one row in a narrow preview', async ({ page }) => {
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('p')[1].firstChild!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  // The visible primary caption must name its action, not a generic "Send".
  await expect(page.locator('.ccgui-md-controls .primary .ccgui-md-button-label')).toHaveText('Add to CC GUI');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByRole('textbox').fill('测试中文批注');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.evaluate(() => {
    const native = window as unknown as { __state: { language: string }; __response: (raw: string) => void };
    native.__state.language = 'zh';
    native.__response(JSON.stringify(native.__state));
  });
  await page.setViewportSize({ width: 200, height: 700 });
  await page.locator('.ccgui-md-marker').click();
  await expect(page.getByRole('dialog', { name: 'Markdown 批注' })).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送此批注到 CC GUI', exact: true })).toHaveAttribute('title', '发送此批注到 CC GUI');
  await expect(page.locator('.ccgui-md-popup .ccgui-md-button-label')).toHaveText('发送此批注到 CC GUI');
  await page.getByRole('button', { name: '发送此批注到 CC GUI', exact: true }).click();
  await expect(page.locator('.ccgui-md-controls')).toContainText('批注已加入当前聊天草稿');
  const row = await page.locator('.ccgui-md-popup .ccgui-md-actions button').evaluateAll(buttons =>
    buttons.map(button => { const rect = button.getBoundingClientRect(); return { top: rect.top, right: rect.right }; }));
  expect(row).toHaveLength(6);
  const closeBox = await page.locator('.ccgui-md-popup-title .ccgui-md-popup-close').boundingBox();
  expect(closeBox!.y).toBeLessThan(row[0].top);
  expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(200);
  expect(new Set(row.map(button => Math.round(button.top))).size).toBe(1);
  expect(row.every(button => button.right <= 200)).toBe(true);
});

test('keeps a saved comment when automatic chat handoff is unavailable', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as unknown as { __autoFail: boolean; __state: { language: string }; __response: (raw: string) => void };
    native.__autoFail = true;
    native.__state.language = 'zh';
    native.__response(JSON.stringify(native.__state));
    const range = document.createRange();
    range.selectNodeContents(document.querySelectorAll('p')[1].firstChild!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: '批注', exact: true }).click();
  await page.getByRole('textbox').fill('保留这条批注');
  await page.getByRole('button', { name: '添加批注', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup')).not.toBeVisible();
  await expect(page.locator('.ccgui-md-controls')).toContainText('批注已保存，但未能加入聊天草稿');
  await expect(page.getByRole('button', { name: '1 条批注', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __requests: { action: string }[] }).__requests.filter(item => item.action === 'create'))).toHaveLength(1);
});

test('Enter adds and saves a comment while Ctrl+Enter and Shift+Enter insert newlines', async ({ page }) => {
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('p')[1].firstChild!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const editor = page.getByRole('textbox');
  await editor.fill('first');
  await editor.press('Control+Enter');
  await editor.press('Shift+Enter');
  await expect(editor).toHaveValue('first\n\n');
  await editor.press('Enter');
  await expect(page.locator('.ccgui-md-popup')).not.toBeVisible();
  await page.locator('.ccgui-md-marker').click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.fill('edited');
  await editor.press('Enter');
  await expect(page.locator('.ccgui-md-marker')).toHaveAttribute('title', 'edited');
});

test('Ctrl+Enter mode preserves Enter newlines and ignores composing or repeated Enter', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as unknown as { __state: { submitShortcut: string }; __response: (raw: string) => void };
    native.__state.submitShortcut = 'ctrlEnter'; native.__response(JSON.stringify(native.__state));
    const range = document.createRange(); range.selectNodeContents(document.querySelectorAll('p')[1].firstChild!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const editor = page.getByRole('textbox');
  await editor.fill('first');
  await editor.press('Enter');
  await expect(editor).toHaveValue('first\n');
  await editor.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true, bubbles: true, cancelable: true }));
  });
  await expect(editor).toBeVisible();
  await editor.press('Control+Enter');
  await expect(page.locator('.ccgui-md-popup')).not.toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __requests: { action: string }[] }).__requests.filter(item => item.action === 'create'))).toHaveLength(1);
});

test('keeps sentence markers separate and only lists all comments from the summary', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as any;
    native.__state.annotations = [
      { id: 'a', revision: 1, start: 82, end: 120, selectedText: 'Second', comment: 'First sentence review', status: 'attached' },
      { id: 'b', revision: 1, start: 82, end: 120, selectedText: 'selection', comment: 'Other sentence review', status: 'attached' },
    ];
    native.__response(JSON.stringify(native.__state));
  });
  await expect(page.locator('.ccgui-md-marker')).toHaveCount(2);
  await page.getByRole('button', { name: 'First sentence review', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup')).toContainText('First sentence review');
  await expect(page.locator('.ccgui-md-popup')).not.toContainText('Other sentence review');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Other sentence review', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup')).not.toContainText('First sentence review');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: '2 comments', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup')).toContainText('Other sentence review');
  await expect(page.locator('.ccgui-md-comment-list > li')).toHaveCount(2);
  await expect(page.locator('.ccgui-md-list-quote')).toHaveText(['Second', 'selection']);
  await expect(page.locator('.ccgui-md-list-comment')).toHaveText(['First sentence review', 'Other sentence review']);
  await expect(page.locator('.ccgui-md-summary .ccgui-md-list-actions')).toHaveCount(2);
  const controls = await page.locator('.ccgui-md-controls').boundingBox();
  expect(controls!.height).toBeLessThanOrEqual(34);
  await page.locator('.ccgui-md-comment-list').getByRole('button', { name: 'Other sentence review', exact: true }).click();
  await expect(page.locator('.ccgui-md-comment-list')).toHaveCount(0);
  await expect(page.locator('.ccgui-md-popup')).toContainText('Other sentence review');
  await expect(page.locator('.ccgui-md-popup')).not.toContainText('First sentence review');
});

test('drags the comment editor and preserves its text and position across state updates', async ({ page }) => {
  await page.evaluate(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('strong')!);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await page.getByRole('textbox').fill('Retain this draft');
  const before = await page.locator('.ccgui-md-popup').boundingBox();
  const title = await page.locator('.ccgui-md-popup-title').boundingBox();
  await page.mouse.move(title!.x + 30, title!.y + 10);
  await page.mouse.down();
  await page.mouse.move(title!.x + 30, title!.y - 65, { steps: 5 });
  await page.mouse.up();
  const after = await page.locator('.ccgui-md-popup').boundingBox();
  expect(after!.y).toBeLessThan(before!.y - 20);
  await page.evaluate(() => { const native = window as any; native.__response(JSON.stringify(native.__state)); });
  await expect(page.getByRole('textbox')).toHaveValue('Retain this draft');
  expect((await page.locator('.ccgui-md-popup').boundingBox())!.y).toBeCloseTo(after!.y, 0);
});

test('annotates Mermaid Visualizer shadow text at its fence while preserving background pan', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as any;
    const host = document.createElement('div');
    host.className = 'mermaid-diagram'; host.dataset.source = 'graph TD\nA[Task scheduler]';
    document.querySelector('body > div')!.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div class="mermaid-zoom-viewport"><div class="mermaid-zoom-content"><svg width="250" height="80"><text x="10" y="30">Task scheduler</text></svg></div></div>';
    shadow.querySelector('.mermaid-zoom-viewport')!.addEventListener('mousedown', event => {
      native.__panned = true; event.preventDefault();
    });
    native.__state.diagrams = [{ start: 125, end: 190, source: host.dataset.source }];
    native.__response(JSON.stringify(native.__state));
  });
  await expect(page.locator('.mermaid-diagram')).toHaveAttribute('data-src', '125..190');
  await page.evaluate(() => {
    const shadow = document.querySelector('.mermaid-diagram')!.shadowRoot!;
    const node = shadow.querySelector('text')!;
    node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true }));
    const range = document.createRange(); range.selectNodeContents(node);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  expect(await page.evaluate(() => (window as any).__panned)).toBeUndefined();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup blockquote')).toHaveText('Task scheduler');
  await page.getByRole('textbox').fill('Change this node');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const request = await page.evaluate(() => (window as any).__requests.find((item: any) => item.action === 'create'));
  expect(request).toMatchObject({ start: 125, end: 190, selectedText: 'Task scheduler' });
  await expect(page.locator('.ccgui-md-marker')).toHaveCount(1);
  await page.evaluate(() => {
    document.querySelector('.mermaid-diagram')!.shadowRoot!.querySelector('svg')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true }));
  });
  expect(await page.evaluate(() => (window as any).__panned)).toBe(true);
});

test('annotates official native Mermaid SVG labels after zoom and native rerender', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as any;
    const source = 'flowchart TD\nA[任务😀调度] --> B[完成]';
    const wrapper = document.createElement('div'); wrapper.className = 'mermaid-wrapper';
    const diagram = document.createElement('div'); diagram.className = 'mermaid';
    diagram.dataset.actualFenceContent = btoa(String.fromCharCode(...new TextEncoder().encode(source)));
    diagram.innerHTML = '<svg width="300" height="90"><foreignObject x="10" y="10" width="250" height="60"><div xmlns="http://www.w3.org/1999/xhtml">任务😀调度</div></foreignObject></svg>';
    wrapper.append(diagram); document.querySelector('body > div')!.append(wrapper);
    native.__state.diagrams = [{ start: 125, end: 195, source }];
    native.__response(JSON.stringify(native.__state));
    // Official renderer handles pan on window; text drags must not reach it.
    window.addEventListener('mousedown', event => {
      if ((event.target as Element).closest('.mermaid')) native.__nativePan = true;
    });
  });
  await expect(page.locator('.mermaid')).toHaveAttribute('data-src', '125..195');
  // The IDE regenerates SVG asynchronously; the mapping and listener must survive.
  await page.evaluate(() => {
    const host = document.querySelector('.mermaid')!;
    host.innerHTML = host.innerHTML;
    (host.querySelector('svg') as SVGElement).style.width = '600px';
    const label = host.querySelector('foreignObject div')!;
    label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const range = document.createRange(); range.selectNodeContents(label);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  expect(await page.evaluate(() => (window as any).__nativePan)).toBeUndefined();
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup blockquote')).toHaveText('任务😀调度');
  await page.getByRole('textbox').fill('原生 Mermaid 节点批注');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const request = await page.evaluate(() => (window as any).__requests.find((item: any) => item.action === 'create'));
  expect(request).toMatchObject({ start: 125, end: 195, selectedText: '任务😀调度' });
  await page.locator('.ccgui-md-marker').click();
  await expect(page.locator('.ccgui-md-popup')).toContainText('原生 Mermaid 节点批注');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.evaluate(() => document.querySelector('.mermaid svg')!
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })));
  expect(await page.evaluate(() => (window as any).__nativePan)).toBe(true);
});

test('completes comments from the list and restores them through the visibility toggle', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as any;
    native.__state.annotations = [
      { id: '000a', revision: 1, start: 82, end: 120, selectedText: 'Second', comment: 'Review to finish', status: 'attached' },
      { id: '000b', revision: 1, start: 82, end: 120, selectedText: 'gone', comment: 'Missing review', status: 'orphaned', sourceMissing: true, completed: true },
    ];
    native.__response(JSON.stringify(native.__state));
  });
  await page.getByRole('button', { name: '1 comments', exact: true }).click();
  await page.locator('.ccgui-md-comment-list').getByRole('button', { name: 'Mark completed', exact: true }).click();
  await expect(page.locator('.ccgui-md-marker')).toHaveCount(0);
  await expect(page.locator('.ccgui-md-comment-list > li')).toHaveCount(1);
  await expect(page.locator('.ccgui-md-list-empty')).toBeVisible();
  await page.getByRole('button', { name: 'Show completed comments', exact: true }).click();
  // The completed pre-seeded "Missing review" is part of the list too.
  await expect(page.locator('.ccgui-md-list-comment')).toHaveText(['Review to finish', 'Missing review']);
  expect(await page.locator('.ccgui-md-comment-list li.completed').first()
    .evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  const finished = page.locator('.ccgui-md-comment-list > li').filter({ hasText: 'Review to finish' });
  await finished.getByRole('button', { name: 'Reopen', exact: true }).click();
  await page.getByRole('button', { name: 'Hide completed comments', exact: true }).click();
  await expect(page.locator('.ccgui-md-list-comment')).toHaveText(['Review to finish']);
  await page.locator('.ccgui-md-comment-list').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox').fill('Edited review');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('.ccgui-md-marker').click();
  await page.getByRole('button', { name: 'Mark completed', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup')).not.toBeVisible();
  await page.getByRole('button', { name: 'Show completed comments', exact: true }).click();
  await page.getByRole('button', { name: '2 comments', exact: true }).click();
  const rows = page.locator('.ccgui-md-comment-list > li');
  await rows.filter({ hasText: 'Edited review' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.ccgui-md-list-comment')).toHaveText(['Missing review']);
  await rows.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.ccgui-md-list-empty')).toBeVisible();
});

test('locates a comment in the preview without closing its detail popup', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as any;
    native.__state.annotations = [
      { id: '000a', revision: 1, start: 82, end: 120, selectedText: 'Second', comment: 'Locate me', status: 'attached' },
    ];
    native.__response(JSON.stringify(native.__state));
  });
  await page.locator('.ccgui-md-marker').click();
  await page.getByRole('button', { name: 'Locate in preview', exact: true }).click();
  await expect(page.locator('.ccgui-md-popup')).toBeVisible();
  expect(await page.evaluate(() =>
    document.querySelector('p[data-src="82..120"]')!.classList.contains('ccgui-md-locate-flash'))).toBe(true);
  expect(await page.evaluate(() => {
    const target = document.querySelector('p[data-src="82..120"]')!.getBoundingClientRect();
    const popup = document.querySelector('.ccgui-md-popup')!.getBoundingClientRect();
    const visible = target.top >= 0 && target.bottom <= innerHeight;
    const overlaps = target.left < popup.right && target.right > popup.left
      && target.top < popup.bottom && target.bottom > popup.top;
    return visible && !overlaps;
  })).toBe(true);
});

test('shows hover descriptions for icon-only controls', async ({ page }) => {
  await page.evaluate(() => {
    const native = window as any;
    native.__state.annotations = [
      { id: '000a', revision: 1, start: 82, end: 120, selectedText: 'Second', comment: 'Hover me', status: 'attached' },
    ];
    native.__response(JSON.stringify(native.__state));
  });
  await page.locator('.ccgui-md-marker').click();
  const tooltip = page.locator('.ccgui-md-tooltip');
  await page.getByRole('button', { name: 'Edit', exact: true }).hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Edit');
  await page.getByRole('button', { name: 'Open in editor', exact: true }).hover();
  await expect(tooltip).toHaveText('Open in editor');
  await page.getByRole('button', { name: 'Locate in preview', exact: true }).hover();
  await expect(tooltip).toHaveText('Locate in preview');
  await page.mouse.move(4, 4);
  await expect(tooltip).toBeHidden();
});
