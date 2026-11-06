import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

interface ForkTestWindow extends Window {
  __bridge: string[];
  __pendingForkTitle?: { sessionId: string; title: string } | undefined;
  __pendingSessionTransitionToast?: { message: string; type: string } | undefined;
  __forkInFlight?: boolean;
  onForkResult?: (json: string) => void;
}

const claudeHistory = {
  success: true,
  source: 'native',
  sessions: [
    {
      sessionId: 'claude-src',
      title: '源会话',
      provider: 'claude',
      messageCount: 4,
      lastTimestamp: '2026-11-04T12:00:00Z',
    },
  ],
  total: 4,
} as never;

const longTitle = '长'.repeat(60);

const longTitleHistory = {
  success: true,
  source: 'native',
  sessions: [
    {
      sessionId: 'claude-long',
      title: longTitle,
      provider: 'claude',
      messageCount: 2,
      lastTimestamp: '2026-11-04T12:00:00Z',
    },
  ],
  total: 2,
} as never;

async function setup(page: Page, opts?: { pendingSessionId?: string }) {
  await page.addInitScript(({ version, pendingSessionId }) => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'claude' }));
    localStorage.setItem('language', 'zh');
    if (pendingSessionId) {
      window.__pendingSessionId = pendingSessionId;
    }
    const bridge = window as unknown as { __bridge: string[] };
    bridge.__bridge = [];
    window.sendToJava = message => {
      bridge.__bridge.push(message);
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => window.updateDependencyStatus?.(JSON.stringify({
          'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
          'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
        })), 0);
      }
    };
  }, { version: APP_VERSION, pendingSessionId: opts?.pendingSessionId });
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
}

/** Push a claude history row in and open the history list. */
async function openHistory(page: Page, historyData: unknown) {
  await page.evaluate(data => { window.setHistoryData?.(data); }, historyData);
  await page.locator('button:has(span.codicon-history)').click();
  await expect(page.locator('.history-item')).toHaveCount(1);
}

/**
 * The row action buttons are `visibility: hidden` until the row is hovered,
 * and Playwright's actionability check runs before its mouse move — so hover
 * the row first, then click the revealed button.
 */
async function clickRowAction(page: Page, selector: string) {
  await page.locator('.history-item').first().hover();
  await page.locator(selector).click();
}

const forkPayloads = (page: Page) =>
  page.evaluate(() => (window as unknown as { __bridge: string[] }).__bridge
    .filter(entry => entry.startsWith('fork_session:'))
    .map(entry => JSON.parse(entry.slice('fork_session:'.length))));

test.describe('history row fork', () => {
  test.beforeEach(async ({ page }) => { await setup(page); });

  test('sends the source id with a suffixed title and reloads the list on success', async ({ page }) => {
    await openHistory(page, claudeHistory);

    await clickRowAction(page, '.history-fork-btn');
    await expect.poll(() => forkPayloads(page)).toHaveLength(1);
    expect(await forkPayloads(page)).toEqual([
      { sessionId: 'claude-src', provider: 'claude', title: '源会话（分叉）' },
    ]);

    // No optimistic insert: the list reload rides the outcome callback.
    await page.evaluate(() => window.onForkResult?.(JSON.stringify({ success: true, newSessionId: 'fork-row-1' })));
    await expect(page.locator('.toast-success .toast-message')).toHaveText('会话已分叉');
    const bridge = await page.evaluate(() => (window as unknown as { __bridge: string[] }).__bridge);
    expect(bridge.some(entry => entry.startsWith('deep_search_history:'))).toBe(true);
    // The guard is released so another fork can start.
    expect(await page.evaluate(() => (window as unknown as { __forkInFlight?: boolean }).__forkInFlight)).toBe(false);
  });

  test('keeps a second fork from starting while one is in flight', async ({ page }) => {
    await openHistory(page, claudeHistory);

    await clickRowAction(page, '.history-fork-btn');
    await expect.poll(() => forkPayloads(page)).toHaveLength(1);

    await clickRowAction(page, '.history-fork-btn');
    expect(await forkPayloads(page)).toHaveLength(1);

    await page.evaluate(() => window.onForkResult?.(JSON.stringify({ success: true, newSessionId: 'fork-row-2' })));
    await expect(page.locator('.toast-success .toast-message')).toHaveText('会话已分叉');

    await clickRowAction(page, '.history-fork-btn');
    await expect.poll(() => forkPayloads(page)).toHaveLength(2);
    expect((await forkPayloads(page))[1]).toMatchObject({ sessionId: 'claude-src' });
  });

  test('reports a localized error and still releases the guard on failure', async ({ page }) => {
    await openHistory(page, claudeHistory);

    await clickRowAction(page, '.history-fork-btn');
    await expect.poll(() => forkPayloads(page)).toHaveLength(1);

    await page.evaluate(() => window.onForkResult?.(JSON.stringify({ success: false, errorCode: 'UNSUPPORTED_PROVIDER' })));
    await expect(page.locator('.toast-error .toast-message')).toHaveText('目前仅支持分叉 Claude 会话');
    expect(await page.evaluate(() => (window as unknown as { __forkInFlight?: boolean }).__forkInFlight)).toBe(false);

    // The failed attempt must not leave a stale pending title behind.
    expect(await page.evaluate(() => (window as unknown as { __pendingForkTitleRequest?: string }).__pendingForkTitleRequest)).toBeUndefined();

    await clickRowAction(page, '.history-fork-btn');
    await expect.poll(() => forkPayloads(page)).toHaveLength(2);
  });

  test('truncates the base title so the suffix survives the 50-char limit', async ({ page }) => {
    await openHistory(page, longTitleHistory);

    await clickRowAction(page, '.history-fork-btn');
    await expect.poll(() => forkPayloads(page)).toHaveLength(1);
    const [payload] = await forkPayloads(page);
    expect(payload.title).toBe(`${'长'.repeat(46)}（分叉）`);
    expect(payload.title.length).toBe(50);
  });

  test('hides the fork action on codex rows', async ({ page }) => {
    const codexHistory = {
      success: true,
      source: 'native',
      sessions: [
        { sessionId: 'codex-row', title: 'Codex 会话', provider: 'codex', messageCount: 3, lastTimestamp: '2026-11-04T12:00:00Z' },
      ],
      total: 3,
    } as never;
    await openHistory(page, codexHistory);
    await expect(page.locator('.history-fork-btn')).toHaveCount(0);
  });
});

test.describe('fork from an assistant message', () => {
  test.beforeEach(async ({ page }) => {
    await setup(page, { pendingSessionId: 'msg-src' });
  });

  const userPrompt = {
    type: 'user',
    timestamp: '2026-11-04T12:00:00Z',
    content: '你好帮我看看',
    message: { role: 'user', content: '你好帮我看看' },
  };
  const replyWithUuid = {
    type: 'assistant',
    timestamp: '2026-11-04T12:00:01Z',
    content: '第一条回复',
    message: { role: 'assistant', content: [{ type: 'text', text: '第一条回复' }] },
    raw: { uuid: 'row-uuid-1' },
  };

  test('carries the row uuid as the fork point and auto-opens the fork', async ({ page }) => {
    await page.evaluate(transcript => {
      window.updateMessages?.(JSON.stringify(transcript));
    }, [userPrompt, replyWithUuid]);
    await expect(page.locator('.message.assistant').first()).toBeVisible();

    // Same visibility-on-hover pattern as the history rows.
    await page.locator('.message.assistant').first().hover();
    await page.locator('.message-fork-btn').first().click();
    await expect.poll(() => forkPayloads(page)).toHaveLength(1);
    expect(await forkPayloads(page)).toEqual([
      {
        sessionId: 'msg-src',
        provider: 'claude',
        title: '你好帮我看看（分叉）',
        forkPointUuid: 'row-uuid-1',
      },
    ]);

    await page.evaluate(() => window.onForkResult?.(JSON.stringify({
      success: true,
      newSessionId: 'fork-msg-1',
      forkPointUuid: 'row-uuid-1',
    })));

    // Auto-open: the forked session loads immediately and the requested title
    // waits to be bound once that session becomes active.
    const bridge = await page.evaluate(() => (window as unknown as { __bridge: string[] }).__bridge);
    const load = bridge.find(entry => entry.startsWith('load_session:'));
    expect(load).toBeTruthy();
    expect(JSON.parse(load!.slice('load_session:'.length))).toMatchObject({ sessionId: 'fork-msg-1' });
    expect(await page.evaluate(() => (window as unknown as ForkTestWindow).__pendingForkTitle)).toEqual({
      sessionId: 'fork-msg-1',
      title: '你好帮我看看（分叉）',
    });
    expect(await page.evaluate(() => (window as unknown as ForkTestWindow).__pendingSessionTransitionToast)).toMatchObject({
      message: '会话已分叉',
      type: 'success',
    });
    // The request-scoped title was consumed by the outcome handler.
    expect(await page.evaluate(() => (window as unknown as ForkTestWindow).__pendingForkTitleRequest)).toBeUndefined();
  });

  test('omits the fork button when the assistant row has no transcript uuid', async ({ page }) => {
    const noUuid = { ...replyWithUuid, raw: {} };
    await page.evaluate(transcript => {
      window.updateMessages?.(JSON.stringify(transcript));
    }, [noUuid]);
    await expect(page.locator('.message.assistant').first()).toBeVisible();
    await expect(page.locator('.message-fork-btn')).toHaveCount(0);
  });
});
