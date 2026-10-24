import { expect, test, type Locator } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(version => {
    localStorage.setItem('language', 'zh');
    localStorage.setItem('lastSeenChangelogVersion', version);
    const bridge = window as Window & {
      storageRequests: string[];
      storageMutationAllowed: boolean;
      storageDeletionAllowed: boolean;
      storageRunningSessionIds: string[];
      storageWriterSessionIds: string[];
      storageCleanupMode: 'complete' | 'pending' | 'error' | 'refused';
      storageCompleteCleanup?: () => void;
      sendToJava: (message: string) => void;
    };
    bridge.storageRequests = [];
    bridge.storageMutationAllowed = true;
    bridge.storageDeletionAllowed = true;
    bridge.storageRunningSessionIds = ['running'];
    bridge.storageWriterSessionIds = ['client-owned'];
    bridge.storageCleanupMode = 'complete';
    const row = (id: string, running = false) => ({ sessionId: id,
      title: id === 'idle' && new URLSearchParams(location.search).has('storage-content-pages') ? 'Codex 会话内容预览与分页验证 '.repeat(12) : id,
      cwd: '/project/' + id, storageMode: 'database',
      fileSize: 0, firstTimestamp: 1, lastTimestamp: 2, archived: false, running, readable: true });
    const deleted = new Set<string>();
    let compactions = 0;
    const mebibyte = 1024 * 1024;
    const mainBytes = 116 * mebibyte;
    const walBytes = 4 * mebibyte;
    const categories = { other: 13 * mebibyte, temporary: 51 * mebibyte, logs: 54 * 1024,
      protectedAssets: 9 * mebibyte, sessions: 880 * mebibyte, historyDatabase: mainBytes + walBytes };
    const operations: Array<Record<string, unknown>> = [];
    if (new URLSearchParams(location.search).has('storage-completed')) operations.push({
      operationId: '04aa435b-dc10-4b27-bd7b-e5c2e517ea51', kind: 'DELETE_SESSIONS', state: 'COMPLETED', targets: ['previously-deleted'],
      createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:01Z',
      result: { deletedSessionIds: ['previously-deleted'], rolloutBytesRemoved: 0, metadataStatus: 'COMPLETE' },
    });
    bridge.sendToJava = message => {
      bridge.storageRequests.push(message);
      const split = message.indexOf(':');
      const action = split < 0 ? message : message.slice(0, split);
      if (action === 'get_ai_data_directory_status') {
        setTimeout(() => bridge.updateAiDataDirectoryStatus?.(JSON.stringify({
          platform: 'windows', supported: true, wsl: false, homeDirectory: 'C:/fixture', recovered: false,
          storageRoot: 'F:/fixture/AI Data', backupCount: 1, backups: [{ id: 'codex', path: 'C:/fixture/.codex.backup' }],
          directories: ['claude', 'codemoss', 'codex'].map(id => ({ id, canonicalPath: `C:/fixture/.${id}`,
            physicalPath: `F:/fixture/AI Data/.${id}`, state: 'linked' })),
        })), 0);
        return;
      }
      if (!['get_ai_storage_usage', 'list_ai_storage_sessions', 'get_ai_storage_session', 'reveal_ai_storage_session', 'get_ai_storage_database_status', 'get_ai_storage_mutation_status',
        'list_ai_storage_maintenance_operations', 'get_ai_storage_maintenance_operation', 'compact_ai_storage_database', 'delete_ai_storage_sessions',
        'preview_ai_storage_orphans', 'clean_ai_storage_orphans'].includes(action)) return;
      const request = JSON.parse(message.slice(split + 1)) as Record<string, unknown>;
      if (action === 'reveal_ai_storage_session' && new URLSearchParams(location.search).has('storage-location-error')) {
        setTimeout(() => bridge.onCodexStorageResponse?.(JSON.stringify({ action, requestId: request.requestId,
          success: false, error: 'SESSION_FILE_NOT_FOUND' })), 0);
        return;
      }
      if (action === 'clean_ai_storage_orphans' && bridge.storageCleanupMode === 'error') {
        setTimeout(() => bridge.onCodexStorageResponse?.(JSON.stringify({ action, requestId: request.requestId,
          success: false, error: 'ORPHAN_PREVIEW_EXPIRED' })), 0);
        return;
      }
      if (action === 'list_ai_storage_sessions' && new URLSearchParams(location.search).has('storage-read-error')) {
        setTimeout(() => bridge.onCodexStorageResponse?.(JSON.stringify({ action, requestId: request.requestId, success: false, error: 'DATABASE_BUSY' })), 0);
        return;
      }
      if (action === 'list_ai_storage_sessions' && new URLSearchParams(location.search).has('storage-incomplete')) {
        const partial = new URLSearchParams(location.search).get('storage-incomplete') === 'partial';
        const data = { sessions: partial ? [{ ...row('readable'), deletionUnavailableReason: 'INVENTORY_INCOMPLETE' }] : [],
          total: partial ? 1 : 0, page: 1, pageSize: Number(request.limit ?? 10), hasMore: false, complete: false, errors: ['state_5.sqlite: READ_FAILED'] };
        setTimeout(() => bridge.onCodexStorageResponse?.(JSON.stringify({ action, requestId: request.requestId, success: true, data })), 0);
        return;
      }
      let data: unknown;
      switch (action) {
        case 'reveal_ai_storage_session': data = { sessionId: request.sessionId }; break;
        case 'get_ai_storage_mutation_status': data = { available: bridge.storageMutationAllowed,
          ...(bridge.storageMutationAllowed ? {} : { unavailableReason: 'SESSION_RUNNING' }),
          deletionAvailable: bridge.storageDeletionAllowed,
          ...(bridge.storageDeletionAllowed ? {} : { deletionUnavailableReason: 'AI_DATA_MIGRATION_ACTIVE' }),
          runningSessionIds: bridge.storageRunningSessionIds, writerSessionIds: bridge.storageWriterSessionIds }; break;
        case 'get_ai_storage_usage': data = { canonicalRoot: 'C:/fixture/.codex',
          physicalRoot: 'F:/fixture/编码测试/Codex-history-with-a-long-directory-name/AI Data/.codex', scannedAt: '2026-10-16T00:00:00Z',
          logicalBytes: Object.values(categories).reduce((total, bytes) => total + bytes, 0), categories,
          skippedLinks: ['skills/shared'], errors: [], complete: true }; break;
        case 'get_ai_storage_database_status': data = { databaseId: 'registered-fixture', name: 'thread_history_1.sqlite', supported: true,
          maintenancePending: false, sizes: { mainBytes, walBytes }, pageSize: 4096, freelistCount: 0 }; break;
        case 'list_ai_storage_sessions': {
          const lineage = new URLSearchParams(location.search).has('storage-lineage');
          const parentTitle = 'CCGUI 主会话 · 办公室与会话父子关系验收'.repeat(3);
          const all = lineage ? [
            { ...row('running', true), title: parentTitle, childCount: 2 },
            { ...row('child-one'), title: '核对办公室设置', subagent: true, parentId: 'running', parentTitle,
              parentAvailable: true, parentIsSubagent: false, childCount: 1 },
            { ...row('nested-child'), title: '验证设置回归', subagent: true, parentId: 'child-one', parentTitle: '核对办公室设置',
              parentAvailable: true, parentIsSubagent: true, childCount: 0 },
            { ...row('archived-child'), title: '已归档的验收子代理', subagent: true, archived: true, parentId: 'running', parentTitle,
              parentAvailable: true, parentIsSubagent: false },
            { ...row('missing-parent'), title: '父会话文件已移除', subagent: true, parentId: '12345678-missing-parent', parentAvailable: false },
            { ...row('unknown-parent'), title: '未提供父会话信息', subagent: true },
          ] : [row('running', true), { ...row('client-owned'), deletionUnavailableReason: 'SESSION_WRITER_BUSY' }, row('idle'),
            ...Array.from({ length: 48 }, (_, index) => ({ ...row(index === 7 ? 'page-two' : `session-${index + 1}`), fileSize: index + 1 }))];
          const needle = String(request.query ?? '').trim().toLowerCase();
          let matched = (needle.includes('outside') ? [row('outside-first-page')] : all.filter(item => !needle || item.cwd.toLowerCase().includes(needle)))
            .filter(item => !deleted.has(item.sessionId))
            .filter(item => request.filter === 'running' ? item.running : request.filter === 'idle'
              ? !item.running && !('deletionUnavailableReason' in item) : request.filter === 'archived' ? item.archived
              : request.filter === 'file' ? item.storageMode === 'file' : true);
          if (request.sort === 'size') matched = matched.sort((left, right) => right.fileSize - left.fileSize);
          const pageSize = Number(request.limit ?? 10);
          const page = Math.min(Number(request.page ?? 1), Math.max(1, Math.ceil(matched.length / pageSize)));
          const offset = (page - 1) * pageSize;
          data = { sessions: matched.slice(offset, offset + pageSize), total: matched.length, page, pageSize,
            hasMore: offset + pageSize < matched.length, nextCursor: `legacy-page-${page + 1}`, complete: true, errors: [] };
          break;
        }
        case 'get_ai_storage_session': {
          const paged = new URLSearchParams(location.search).has('storage-content-pages');
          data = { sessionId: request.sessionId,
            records: paged ? request.cursor ? [{ text: 'second content page', truncated: false }]
              : Array.from({ length: 20 }, (_, index) => ({ text: index === 0 ? 'first content page\n' + 'Long conversation line. '.repeat(600)
                : `Conversation record ${index + 1}`, truncated: false })) : [{ text: 'history from database', truncated: false }],
            hasMore: paged && !request.cursor, ...(paged && !request.cursor ? { nextCursor: 'fixture:20' } : {}) };
          break;
        }
        case 'preview_ai_storage_orphans': data = new URLSearchParams(location.search).has('storage-no-orphans')
          ? { databaseId: 'registered-fixture', previewToken: 'a'.repeat(64), candidateCount: 0, rowCount: 0, estimatedBytes: 0,
            retainedFileSessions: 17, skippedBusyCount: 0, skippedExistingCount: 0, candidates: [] }
          : { databaseId: 'registered-fixture', previewToken: 'a'.repeat(64), candidateCount: 93,
          rowCount: 71000, estimatedBytes: 466 * 1024 * 1024, retainedFileSessions: 17, skippedBusyCount: 0, skippedExistingCount: 0,
          candidates: [{ sessionId: 'missing-rollout', title: 'Missing', estimatedBytes: 1024 }] }; break;
        case 'list_ai_storage_maintenance_operations': data = operations; break;
        case 'get_ai_storage_maintenance_operation': data = operations.find(item => item.operationId === request.operationId); break;
        default: {
          const compact = action === 'compact_ai_storage_database';
          const cleanup = action === 'clean_ai_storage_orphans';
          const deletedIds = !compact && !cleanup && Array.isArray(request.sessionIds)
            ? request.sessionIds.filter((id): id is string => typeof id === 'string') : [];
          deletedIds.forEach(id => deleted.add(id));
          const releasedBytes = cleanup ? 466 * 1024 * 1024 : compact ? (compactions++ === 0 ? 0 : -1024) : 0;
          data = { operationId: request.operationId, kind: cleanup ? 'CLEAN_ORPHANED_HISTORY' : compact ? 'COMPACT_DATABASE' : 'DELETE_SESSIONS', state: 'COMPLETED',
            targets: cleanup ? [request.previewToken] : compact ? ['thread_history_1.sqlite'] : request.sessionIds, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:01Z',
            result: cleanup ? { cleanedSessionCount: 93, releasedBytes } : compact ? { releasedBytes, before: { mainBytes }, after: { mainBytes: mainBytes - releasedBytes } }
              : { deletedSessionIds: deletedIds, rolloutBytesRemoved: 0, metadataStatus: 'COMPLETE' } };
          if (cleanup && bridge.storageCleanupMode === 'refused') {
            data = { ...data as Record<string, unknown>, state: 'FAILED_CLEAN', error: 'DATABASE_BUSY', result: undefined };
          }
          operations.unshift(data as Record<string, unknown>);
        }
      }
      if (action === 'clean_ai_storage_orphans' && bridge.storageCleanupMode === 'pending') {
        const receipt = data as Record<string, unknown>;
        const result = receipt.result;
        delete receipt.result;
        receipt.state = 'PREPARING';
        bridge.storageCompleteCleanup = () => {
          receipt.state = 'COMPLETED';
          receipt.result = result;
          bridge.onCodexStorageResponse?.(JSON.stringify({ action, requestId: request.requestId, success: true, data: receipt }));
          delete bridge.storageCompleteCleanup;
        };
        return;
      }
      setTimeout(() => bridge.onCodexStorageResponse?.(JSON.stringify({ action, requestId: request.requestId,
        success: data !== undefined, ...(data === undefined ? { error: 'OPERATION_NOT_FOUND' } : { data }) })), 0);
    };
  }, APP_VERSION);
  await page.goto('/');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const sidebar = page.getByText('AI 数据存储', { exact: true });
  await sidebar.locator('..').click();
  await expect(page.getByRole('region', { name: 'Codex 空间管理' })).toBeVisible();
});

async function openSessions(panel: Locator) {
  const summary = panel.getByText('查看与删除', { exact: true });
  if (!await summary.locator('../..').evaluate(element => (element as HTMLDetailsElement).open)) await summary.click();
}

test('shows Codex parent and subagent relationships without changing deletion protection', async ({ page }, info) => {
  await page.evaluate(() => history.replaceState(null, '', '/?storage-lineage=1'));
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  const refresh = panel.getByRole('button', { name: '刷新', exact: true });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await openSessions(panel);
  const main = panel.getByText('/project/running', { exact: true }).locator('../..');
  const child = panel.getByText('/project/child-one', { exact: true }).locator('../..');
  const nested = panel.getByText('/project/nested-child', { exact: true }).locator('../..');
  const missing = panel.getByText('/project/missing-parent', { exact: true }).locator('../..');
  const unknown = panel.getByText('/project/unknown-parent', { exact: true }).locator('../..');
  await expect(main.getByText('主会话', { exact: true })).toBeVisible();
  await expect(main.getByText('子代理 2 个', { exact: true })).toBeVisible();
  await expect(main.getByRole('checkbox')).toBeDisabled();
  await expect(main.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(child.getByText('子代理', { exact: true })).toBeVisible();
  await expect(child.getByText('主会话：', { exact: true })).toBeVisible();
  await expect(child.getByText('子代理 1 个', { exact: true })).toBeVisible();
  await expect(nested.getByText('父会话：', { exact: true })).toBeVisible();
  await expect(nested.getByText('核对办公室设置', { exact: true })).toBeVisible();
  await expect(missing.getByText('12345678', { exact: true })).toBeVisible();
  await expect(missing.getByText('（无会话文件）', { exact: true })).toBeVisible();
  await expect(unknown.getByText('父会话信息不可用', { exact: true })).toBeVisible();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await child.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('codex-storage-lineage.png'), animations: 'disabled' });
  await child.getByRole('button', { name: '查看内容', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('子代理', { exact: true })).toBeVisible();
  await expect(dialog.getByText('主会话：', { exact: true })).toBeVisible();
  await expect(dialog.getByText('CCGUI 主会话 · 办公室与会话父子关系验收'.repeat(3), { exact: true })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests
    .filter(message => message.startsWith('delete_ai_storage_sessions:')))).toEqual([]);
});

test('retains a subagent parent name when archive filtering hides its main session', async ({ page }) => {
  await page.evaluate(() => history.replaceState(null, '', '/?storage-lineage=1'));
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  await panel.getByRole('combobox', { name: '会话筛选', exact: true }).selectOption('archived');
  const archived = panel.getByText('/project/archived-child', { exact: true }).locator('../..');
  await expect(archived.getByText('子代理', { exact: true })).toBeVisible();
  await expect(archived.getByText('CCGUI 主会话 · 办公室与会话父子关系验收'.repeat(3), { exact: true })).toBeVisible();
  await expect(archived.getByText(/· 已归档$/)).toBeVisible();
  await expect(panel.getByText('/project/running', { exact: true })).toHaveCount(0);
  await expect(archived.getByText('（无会话文件）', { exact: true })).toHaveCount(0);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test('a target becoming busy closes its deletion confirmation and recovers without rescanning', async ({ page }) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  const idle = panel.getByText('/project/idle', { exact: true }).locator('../..');
  const remove = idle.getByRole('button', { name: '删除', exact: true });
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(page.locator('.modal-btn-danger')).toBeVisible();
  await page.evaluate(() => {
    (window as Window & { storageRunningSessionIds: string[] }).storageRunningSessionIds.push('idle');
  });
  await expect(remove).toBeDisabled();
  await expect(idle.getByRole('checkbox')).toBeDisabled();
  await expect(page.locator('.modal-btn-danger')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests
    .filter(message => message.startsWith('delete_ai_storage_sessions:')))).toEqual([]);
  await page.evaluate(() => {
    const bridge = window as Window & { storageRunningSessionIds: string[] };
    bridge.storageRunningSessionIds = bridge.storageRunningSessionIds.filter(id => id !== 'idle');
  });
  await expect(remove).toBeEnabled();
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests
    .filter(message => message.startsWith('list_ai_storage_sessions:')))).toHaveLength(1);
});

test('deletes an idle history while a different Codex session blocks global maintenance', async ({ page }) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await page.evaluate(() => { (window as Window & { storageMutationAllowed: boolean }).storageMutationAllowed = false; });
  await expect(panel.getByText('有 Codex 会话正在执行，清理和压缩暂不可用；空闲会话仍可删除。', { exact: true })).toBeVisible();
  await openSessions(panel);
  const running = panel.getByText('/project/running', { exact: true }).locator('../..');
  const writer = panel.getByText('/project/client-owned', { exact: true }).locator('../..');
  const idle = panel.getByText('/project/idle', { exact: true }).locator('../..');
  await expect(running.getByRole('checkbox')).toBeDisabled();
  await expect(writer.getByRole('checkbox')).toBeDisabled();
  await expect(writer).toContainText('客户端占用，暂不可删除');
  await expect(idle.getByRole('checkbox')).toBeEnabled();
  await idle.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.modal-btn-danger').click();
  await expect(idle).toHaveCount(0);
  const requests = await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests);
  const deletions = requests.filter(message => message.startsWith('delete_ai_storage_sessions:'));
  expect(deletions).toHaveLength(1);
  expect(JSON.parse(deletions[0]!.slice(deletions[0]!.indexOf(':') + 1))).toMatchObject({ sessionIds: ['idle'] });
  expect(requests.filter(message => message.startsWith('compact_ai_storage_database:') || message.startsWith('clean_ai_storage_orphans:'))).toEqual([]);
});

test('opens a running session location without previewing or deleting its history', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  const running = panel.getByText('/project/running', { exact: true }).locator('../..');
  const button = running.getByRole('button', { name: '打开存储位置', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'false');
  const requests = await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests);
  const reveals = requests.filter(message => message.startsWith('reveal_ai_storage_session:'));
  expect(reveals).toHaveLength(1);
  expect(JSON.parse(reveals[0]!.slice(reveals[0]!.indexOf(':') + 1))).toMatchObject({ sessionId: 'running', provider: 'codex' });
  expect(requests.filter(message => /^(get_ai_storage_session|delete_ai_storage_sessions|compact_ai_storage_database):/.test(message))).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('codex-storage-open-location.png'), animations: 'disabled' });
});

test('reports a missing history file and restores the open-location button', async ({ page }) => {
  await page.evaluate(() => history.replaceState(null, '', '/?storage-location-error=1'));
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  const idle = panel.getByText('/project/idle', { exact: true }).locator('../..');
  const button = idle.getByRole('button', { name: '打开存储位置', exact: true });
  await button.click();
  await expect(page.getByText('未找到该会话的聊天记录文件，请刷新列表后重试。', { exact: true })).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).toHaveAttribute('aria-busy', 'false');
});

test('bulk deletion skips protected targets and refuses the entire batch if one becomes busy before submission', async ({ page }) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  await panel.getByRole('checkbox', { name: '全选本页可删除会话' }).check();
  const running = panel.getByText('/project/running', { exact: true }).locator('../..');
  const writer = panel.getByText('/project/client-owned', { exact: true }).locator('../..');
  await expect(running.getByRole('checkbox')).not.toBeChecked();
  await expect(writer.getByRole('checkbox')).not.toBeChecked();
  await panel.getByRole('button', { name: /删除所选/ }).click();
  await page.evaluate(() => {
    (window as Window & { storageWriterSessionIds: string[] }).storageWriterSessionIds.push('idle');
  });
  await page.locator('.modal-btn-danger').click();
  const idle = panel.getByText('/project/idle', { exact: true }).locator('../..');
  await expect(idle.getByRole('checkbox')).toBeDisabled();
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests
    .filter(message => message.startsWith('delete_ai_storage_sessions:')))).toEqual([]);
});

test('browse all sessions, protect running targets, confirm irreversible deletion and keep the layout usable', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  const running = panel.getByText('/project/running', { exact: true }).locator('../..');
  await expect(running.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(running.getByRole('checkbox')).toBeDisabled();
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests.filter(item => item.startsWith('get_ai_storage_session:')))).toEqual([]);
  await panel.getByRole('navigation', { name: '会话分页' }).getByTitle('下一页', { exact: true }).click();
  await expect(panel.getByText('/project/page-two', { exact: true })).toBeVisible();
  await panel.getByRole('textbox', { name: '搜索标题、项目路径或会话 ID' }).fill('outside');
  await expect(panel.getByText('/project/outside-first-page', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '查看内容' }).click();
  const contentDialog = page.getByRole('dialog', { name: '会话内容', exact: true });
  await contentDialog.getByText('记录 1', { exact: true }).click();
  await expect(contentDialog.locator('pre').filter({ hasText: 'history from database' })).toBeVisible();
  await contentDialog.getByRole('button', { name: '关闭内容' }).click();
  await expect(contentDialog).toHaveCount(0);
  await panel.getByRole('textbox', { name: '搜索标题、项目路径或会话 ID' }).fill('');
  const idle = panel.getByText('/project/idle', { exact: true }).locator('../..');
  await idle.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.modal-content')).toContainText(/无法撤销|无法恢复/);
  await page.locator('.modal-content').getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests.filter(item => item.startsWith('delete_ai_storage_sessions:')))).toEqual([]);
  await idle.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.modal-btn-danger').click();
  await expect(panel.getByText('/project/idle', { exact: true })).toHaveCount(0);
  const requests = await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests);
  expect(requests.filter(item => item.startsWith('delete_ai_storage_sessions:'))).toHaveLength(1);
  expect(requests.filter(item => item.startsWith('delete_session:') || item.startsWith('delete_sessions:'))).toEqual([]);
  await expect(panel.getByText('已完成', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('已删除会话文件：0 B', { exact: true })).toHaveCount(0);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('codex-storage.png') });
});

test('previews content in a scrollable dialog and returns focus to the unchanged session list', async ({ page }, info) => {
  await page.evaluate(() => history.replaceState(null, '', '/?storage-content-pages=1'));
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await openSessions(panel);
  const idle = panel.getByText('/project/idle', { exact: true }).locator('../..');
  const view = idle.getByRole('button', { name: '查看内容', exact: true });
  await view.scrollIntoViewIfNeeded();
  const scrollPositions = () => view.evaluate(element => {
    const offsets: number[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) offsets.push(parent.scrollTop);
    return offsets;
  });
  const originalScroll = await scrollPositions();
  await view.click();
  const dialog = page.getByRole('dialog', { name: '会话内容', exact: true });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByText('/project/idle', { exact: true })).toBeVisible();
  await dialog.getByText('记录 1', { exact: true }).click();
  await expect(dialog.locator('pre').filter({ hasText: 'first content page' })).toBeVisible();
  const records = dialog.locator('section[aria-busy]');
  expect(await records.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(dialog.getByRole('button', { name: '下一页内容', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('codex-storage-content-dialog.png'), animations: 'disabled' });
  await records.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await dialog.getByRole('button', { name: '下一页内容', exact: true }).click();
  await expect(dialog.getByText('第 2 页', { exact: true })).toBeVisible();
  expect(await records.evaluate(element => element.scrollTop)).toBe(0);
  await dialog.getByText('记录 1', { exact: true }).click();
  await expect(dialog.locator('pre')).toHaveText('second content page');
  await expect(dialog.getByRole('button', { name: '下一页内容', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(dialog.getByText('第 1 页', { exact: true })).toBeVisible();
  await expect(records).toBeFocused();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(view).toBeFocused();
  expect(await scrollPositions()).toEqual(originalScroll);
  await expect(panel.getByRole('checkbox', { name: /^选择会话：/ })).toHaveCount(10);
  await view.click();
  await expect(dialog.getByText('第 1 页', { exact: true })).toBeVisible();
  await page.locator('.ant-modal-wrap').click({ position: { x: 2, y: 2 } });
  await expect(dialog).toHaveCount(0);
  await expect(view).toBeFocused();
  const requests = await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests);
  expect(requests.filter(item => item.startsWith('delete_ai_storage_sessions:') || item.startsWith('delete_session:') || item.startsWith('delete_sessions:'))).toEqual([]);
});

test('paginates sessions, changes page size and recovers after deleting the last page', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  const rows = panel.getByRole('checkbox', { name: /^选择会话：/ });
  const pager = panel.getByRole('navigation', { name: '会话分页' });
  const size = pager.getByRole('combobox', { name: '每页条数' });
  await expect(rows).toHaveCount(10);
  await expect(size).toHaveValue('10');
  expect(await size.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['10', '15', '20', '50', '100']);
  await panel.getByRole('checkbox', { name: '全选本页可删除会话' }).check();
  await pager.getByTitle('2', { exact: true }).click();
  await expect(panel.getByText('/project/page-two', { exact: true })).toBeVisible();
  await expect(panel.getByText('/project/page-two', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(rows).toHaveCount(10);
  expect(await rows.evaluateAll(inputs => inputs.some(input => (input as HTMLInputElement).checked))).toBe(false);
  await pager.getByRole('textbox').fill('5');
  await pager.getByRole('textbox').press('Enter');
  await expect.poll(async () => page.evaluate(() => {
    const request = (window as Window & { storageRequests: string[] }).storageRequests.filter(item => item.startsWith('list_ai_storage_sessions:')).at(-1)!;
    return (JSON.parse(request.slice(request.indexOf(':') + 1)) as { page: number }).page;
  })).toBe(5);
  for (const value of [15, 20, 50, 100]) {
    await size.selectOption(String(value));
    await expect(rows).toHaveCount(Math.min(51, value));
    await expect(panel.getByText('/project/running', { exact: true })).toBeVisible();
  }
  await size.selectOption('10');
  await expect(rows).toHaveCount(10);
  await pager.getByTitle('6', { exact: true }).click();
  await expect(rows).toHaveCount(1);
  await panel.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.modal-content')).toContainText(/无法撤销|无法恢复/);
  await page.locator('.modal-btn-danger').click();
  await expect(rows).toHaveCount(10);
  await expect(pager.getByText('共 50 条', { exact: true })).toBeVisible();
  await expect(pager.getByTitle('下一页', { exact: true }).getByRole('button')).toBeDisabled();
  await pager.scrollIntoViewIfNeeded();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('codex-storage-pagination.png'), animations: 'disabled' });
});

test('database compaction reports zero and negative measured savings without a second delete confirmation', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await panel.getByText('占用明细与数据库压缩', { exact: true }).click();
  const compact = panel.getByRole('button', { name: '压缩空闲页', exact: true });
  await panel.getByRole('group', { name: '数据库压缩', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('codex-storage-details.png'), animations: 'disabled' });
  await compact.click();
  await expect(page.locator('.toast-message').filter({ hasText: '本次未释放额外空间' })).toBeVisible();
  await expect(panel.getByText('已完成', { exact: true })).toHaveCount(0);
  await expect(panel.locator('.modal-overlay')).toHaveCount(0);
  await expect(compact).toBeEnabled();
  await compact.click();
  const increased = page.locator('.toast-message').filter({ hasText: '本次占用增加：1.0 KiB' });
  await expect(increased).toBeVisible();
  const requests = await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests.filter(item => item.startsWith('compact_ai_storage_database:')));
  expect(requests).toHaveLength(2);
  const first = JSON.parse(requests[0]!.slice(requests[0]!.indexOf(':') + 1)) as Record<string, unknown>;
  const second = JSON.parse(requests[1]!.slice(requests[1]!.indexOf(':') + 1)) as Record<string, unknown>;
  expect(first.databaseId).toBe('registered-fixture');
  expect(first.operationId).not.toBe(second.operationId);
  await expect(increased).toHaveCount(0);
  await expect(panel.getByText('本次占用增加：1.0 KiB', { exact: true })).toHaveCount(0);
  await panel.getByText('扫描信息', { exact: true }).click();
  await page.screenshot({ path: info.outputPath('codex-storage-scan-details.png'), animations: 'disabled' });
});

test('distinguishes client writer locks and failed reads from running tasks and empty history', async ({ page }, info) => {
  test.setTimeout(60_000);
  let panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await openSessions(panel);
  const occupied = panel.getByText('/project/client-owned', { exact: true }).locator('../..');
  await expect(occupied).toContainText('客户端占用，暂不可删除');
  await expect(occupied.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(occupied.getByRole('button', { name: '查看内容', exact: true })).toBeEnabled();
  await expect(occupied.getByText('进行中，无法删除')).toHaveCount(0);
  await page.goto('/?storage-read-error=1');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('AI 数据存储', { exact: true }).locator('..').click();
  panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await expect(panel.getByRole('alert')).toContainText('会话列表读取失败');
  await expect(panel.getByRole('heading', { name: '全部 Codex 会话', exact: true })).toBeVisible();
  await expect(panel.getByText('没有符合条件的会话', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: '全部 Codex 会话（0）', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '分析可清理空间', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('codex-storage-read-failed.png') });
});

test('distinguishes incomplete zero and partial inventories from a fully read empty history', async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.goto('/?storage-incomplete=empty');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('AI 数据存储', { exact: true }).locator('..').click();
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await expect(panel.getByRole('alert')).toContainText('会话列表读取失败');
  await expect(panel.getByRole('heading', { name: '全部 Codex 会话', exact: true })).toBeVisible();
  await expect(panel.getByText('没有符合条件的会话', { exact: true })).toHaveCount(0);
  await page.evaluate(() => history.replaceState(null, '', '/?storage-incomplete=partial'));
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  const heading = panel.getByRole('heading', { name: 'Codex 会话（已读取 1 个，扫描不完整）', exact: true });
  await expect(heading).toBeVisible();
  await openSessions(panel);
  const readable = panel.getByText('/project/readable', { exact: true }).locator('../..');
  await expect(readable.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(readable.getByRole('button', { name: '查看内容', exact: true })).toBeEnabled();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await heading.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('codex-storage-incomplete.png') });
});

test('requires a reviewed missing-rollout preview before destructive cleanup and compaction', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await panel.getByRole('button', { name: '分析可清理空间', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('93 个会话已无对应 JSONL');
  await expect(dialog).toContainText('466.0 MiB');
  await expect(dialog).toContainText('删除后无法恢复');
  await expect(dialog).toContainText('17 个会话');
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests.filter(item => item.startsWith('clean_ai_storage_orphans:')))).toEqual([]);
  await page.screenshot({ path: info.outputPath('codex-storage-cleanup-confirmation.png') });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await panel.getByRole('button', { name: '分析可清理空间', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '永久清理并压缩', exact: true }).click();
  const completed = page.locator('.toast-message').filter({ hasText: '已清理 93 个残留会话' });
  await expect(completed).toContainText('本次净释放：466.0 MiB');
  await expect(panel.getByText('已完成', { exact: true })).toHaveCount(0);
  await expect(completed).toHaveCount(0);
  await openSessions(panel);
  await expect(panel.getByText('/project/idle', { exact: true })).toBeVisible();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('codex-storage-cleanup-completed.png') });
});

test('shows pending cleanup progress without randomUUID and reports completion once', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => { errors.push(error.message); });
  await page.evaluate(() => {
    Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true });
    (window as Window & { storageCleanupMode: string }).storageCleanupMode = 'pending';
  });
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await panel.getByRole('button', { name: '分析可清理空间', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '永久清理并压缩', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const progress = panel.getByRole('status').filter({ hasText: '清理残留并压缩' });
  await expect(progress).toContainText(/处理中|检查中/);
  await expect(panel.getByRole('button', { name: '分析可清理空间', exact: true })).toBeDisabled();
  await expect(progress).toContainText('检查中');
  await progress.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('codex-storage-cleanup-progress.png') });
  await page.evaluate(() => (window as Window & { storageCompleteCleanup?: () => void }).storageCompleteCleanup?.());
  const completed = page.locator('.toast-message').filter({ hasText: '已清理 93 个残留会话' });
  await expect(completed).toContainText('本次净释放：466.0 MiB');
  await expect(panel.getByText('检查中', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '分析可清理空间', exact: true })).toBeEnabled();
  const requests = await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests
    .filter(message => message.startsWith('clean_ai_storage_orphans:')));
  expect(requests).toHaveLength(1);
  const request = JSON.parse(requests[0].slice(requests[0].indexOf(':') + 1)) as { operationId: string };
  expect(request.operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(errors).toEqual([]);
});

for (const failure of ['error', 'refused'] as const) {
  test(`reports cleanup ${failure} after closing confirmation and allows a fresh attempt`, async ({ page }, info) => {
    await page.evaluate(mode => { (window as Window & { storageCleanupMode: string }).storageCleanupMode = mode; }, failure);
    const panel = page.getByRole('region', { name: 'Codex 空间管理' });
    await panel.getByRole('button', { name: '分析可清理空间', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '永久清理并压缩', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(panel.getByRole('alert')).toContainText(failure === 'error' ? '清理范围已发生变化' : '数据正在使用或维护中');
    await panel.getByRole('alert').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`codex-storage-cleanup-${failure}.png`) });
    await expect(panel.getByRole('button', { name: '分析可清理空间', exact: true })).toBeEnabled();
    await page.evaluate(() => { (window as Window & { storageCleanupMode: string }).storageCleanupMode = 'complete'; });
    await panel.getByRole('button', { name: '分析可清理空间', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '永久清理并压缩', exact: true }).click();
    await expect(page.locator('.toast-message').filter({ hasText: '已清理 93 个残留会话' })).toBeVisible();
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });
}

test('hides destructive cleanup for empty analysis and locates free-page compaction without executing it', async ({ page }, info) => {
  await page.goto('/?storage-no-orphans=1');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('AI 数据存储', { exact: true }).locator('..').click();
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  const compact = panel.getByRole('button', { name: '压缩空闲页', exact: true });
  await expect(compact).not.toBeVisible();
  await panel.getByRole('button', { name: '分析可清理空间', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '可清理空间分析结果' });
  await expect(dialog).toContainText('当前没有可清理的残留历史。');
  await expect(dialog.getByRole('button', { name: '永久清理并压缩', exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/永久删除|删除后无法恢复/)).toHaveCount(0);
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('codex-storage-no-orphans.png') });
  await dialog.getByRole('button', { name: '查看空闲页压缩', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(compact).toBeVisible();
  await expect(compact).toBeInViewport({ ratio: 1 });
  await expect(panel.getByText('空闲空间估算', { exact: true })).toBeVisible();
  const mutations = await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests
    .filter(item => item.startsWith('clean_ai_storage_orphans:') || item.startsWith('compact_ai_storage_database:')));
  expect(mutations).toEqual([]);
  await page.screenshot({ path: info.outputPath('codex-storage-compaction-located.png') });
});

test('does not bring completed operation cards back when settings reloads or refreshes', async ({ page }, info) => {
  await page.goto('/?storage-completed=1');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByText('AI 数据存储', { exact: true }).locator('..').click();
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  await expect(panel.getByRole('heading', { name: '全部 Codex 会话（51）', exact: true })).toBeVisible();
  await expect(panel.getByText('已完成', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('已删除会话文件：0 B', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(panel.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await expect(panel.getByText('已完成', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('codex-storage-no-completed-record.png') });
});

test('keeps secondary blocks folded and preserves migration confirmation inside directory settings', async ({ page }, info) => {
  const panel = page.getByRole('region', { name: 'Codex 空间管理' });
  const search = panel.getByRole('textbox', { name: '搜索标题、项目路径或会话 ID' });
  await expect(search).not.toBeVisible();
  await expect(panel.getByRole('button', { name: '压缩空闲页', exact: true })).not.toBeVisible();
  await expect(panel.getByRole('button', { name: '分析可清理空间', exact: true })).toBeVisible();
  await expect(page.locator('input[value="F:/fixture/AI Data"]')).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('ai-storage-overview-folded.png') });

  await openSessions(panel);
  await expect(search).toBeVisible();
  await panel.getByText('查看与删除', { exact: true }).click();
  await expect(search).not.toBeVisible();
  await page.getByText('存储位置与迁移', { exact: true }).click();
  const target = page.getByRole('textbox');
  await expect(target).toHaveValue('F:/fixture/AI Data');
  await expect(page.getByText('C:/fixture/.codex', { exact: true })).toBeVisible();
  await target.fill('G:/fixture/New AI Data');
  await page.getByRole('button', { name: '迁移数据', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('G:/fixture/New AI Data');
  await expect(page.getByRole('dialog')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('dialog').getByRole('button', { name: '开始迁移', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath('ai-storage-migration-confirmation.png') });
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect(await page.evaluate(() => (window as Window & { storageRequests: string[] }).storageRequests
    .filter(item => item.startsWith('migrate_ai_data_directories:')))).toEqual([]);
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.getByText('存储位置与迁移', { exact: true }).locator('../..')
    .evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('ai-storage-directory-expanded.png') });
});
