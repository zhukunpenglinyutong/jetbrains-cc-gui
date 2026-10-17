import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readNativeSubagent } from '../../ai-bridge/services/codex/codex-native-subagents.js';
import { projectCodexItemMessages } from '../../ai-bridge/services/codex/codex-item-projection.js';
import { APP_VERSION } from '../src/version/version';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(version => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'codex', codexModel: 'gpt-5.5' }));
    const bridge = window as Window & { __agentBridgeMessages?: string[] };
    bridge.__agentBridgeMessages = [];
    window.sendToJava = message => {
      bridge.__agentBridgeMessages?.push(message);
      if (message.startsWith('get_dependency_status:')) setTimeout(() => window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
        'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
      })), 0);
    };
  }, APP_VERSION);
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'codex');
});

for (const childCount of [1, 2]) test(`Codex native spawn prompt appears in ${childCount} shared child detail cards and survives history load`, async ({ page }) => {
  const prompt = 'Inspect the compact request and report its terminal result.';
  const sessionId = 'native-prompt-root';
  const receiverThreadIds = Array.from({ length: childCount }, (_, index) => `native-prompt-child-${index}`);
  const messages = projectCodexItemMessages({ id: 'native-prompt-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent',
    status: 'completed', prompt, receiverThreadIds,
    agentsStates: Object.fromEntries(receiverThreadIds.map(id => [id, { status: 'running' }])) },
  { threadId: sessionId, turnId: 'native-prompt-turn', authoritative: true }).map(raw => ({ type: raw.type, content: '', raw }));
  await page.evaluate(({ messages, sessionId }) => {
    window.setSessionId?.(sessionId);
    window.updateMessages?.(JSON.stringify(messages));
  }, { messages, sessionId });
  const card = page.locator('.agent-group-container');
  await expect(card).toHaveCount(1);
  await card.locator('.task-header').click();
  await expect(card.locator('.subagent-prompt-card')).toHaveText(Array(childCount).fill(prompt));
  await expect(card.locator('.tool-status-indicator.pending')).toHaveCount(1);
  const agentTab = page.locator('.status-panel-tab').nth(1);
  await expect(agentTab.locator('.tab-progress')).toHaveText(`0/${childCount}`);
  await agentTab.click();
  await expect(page.locator('.subagent-item')).toHaveCount(childCount);
  await page.locator('.subagent-item').first().click();
  await expect(page.locator('.status-panel-popover .subagent-prompt-card')).toHaveText(prompt);
  await agentTab.click();
  await page.evaluate(({ messages, sessionId }) => {
    window.beginCodexHistoryPage?.(JSON.stringify({ pageId: 'native-prompt-history', sessionId, mode: 'replace' }));
    window.appendCodexHistoryPageBatch?.('native-prompt-history', JSON.stringify(messages));
    window.completeCodexHistoryPage?.(JSON.stringify({ pageId: 'native-prompt-history', sessionId, mode: 'replace', source: 'native',
      cursor: null, hasMore: false, fromTurn: 0, toTurn: 1, totalTurns: 1, loadedMessageCount: messages.length }));
  }, { messages, sessionId });
  await expect(card.locator('.subagent-prompt-card')).toHaveText(Array(childCount).fill(prompt));
  await expect(agentTab.locator('.tab-progress')).toHaveText(`0/${childCount}`);
});

test('Codex subagent cards share native identities, reports and multi-agent counts live and after history load', async ({ page }, testInfo) => {
  const messages = await page.evaluate(() => {
    const rawMeta = { codexThreadId: 'agent-root', codexTurnId: 'agent-turn' };
    const messages = [{ type: 'user', content: 'Review two modules' }, ...['one', 'two'].flatMap(name => [
      { type: 'assistant', content: '', raw: { ...rawMeta, uuid: `launch-${name}`, message: { content: [{ type: 'tool_use',
        id: `launch-${name}`, name: 'spawn_agent', input: { task_name: `review_${name}`, message: 'opaque task transport' } }] } } },
      { type: 'user', content: '[tool_result]', raw: { ...rawMeta, uuid: `receipt-${name}`, message: { content: [{ type: 'tool_result',
        tool_use_id: `launch-${name}`, content: JSON.stringify({ task_name: `/root/review_${name}` }) }] } } },
      { type: 'assistant', content: '', raw: { ...rawMeta, uuid: `activity-${name}`, codexItemType: 'subAgentActivity', message: {
        content: [{ type: 'tool_use', id: `activity-${name}`, name: 'subAgentActivity', input: {
          kind: 'started', agentThreadId: `child-${name}`, agentPath: `/root/review_${name}`,
        } }] } } },
    ])];
    window.setSessionId?.('agent-root');
    window.onStreamStart?.();
    window.updateMessages?.(JSON.stringify(messages));
    return messages;
  });
  const cards = page.locator('.agent-group-container');
  await expect(cards).toHaveCount(2);
  await expect(cards.locator('.tool-status-indicator.pending')).toHaveCount(2);
  const agentTab = page.locator('.status-panel-tab').nth(1);
  await expect(agentTab.locator('.tab-progress')).toHaveText('0/2');
  await expect(page.locator('.tool-title-text', { hasText: 'spawn_agent' })).toHaveCount(0);
  await expect(page.locator('.tool-title-text', { hasText: 'subAgentActivity' })).toHaveCount(0);

  const doneMessages = [...messages, { type: 'assistant', content: '', raw: { codexThreadId: 'agent-root', codexTurnId: 'agent-turn',
    codexItemType: 'subAgentActivity', uuid: 'finished-one', message: { content: [{ type: 'tool_use', id: 'finished-one',
      name: 'subAgentActivity', input: { kind: 'completed', agentThreadId: 'child-one', agentPath: '/root/review_one' } }] } } }];
  await page.evaluate(messages => window.updateMessages?.(JSON.stringify(messages)), doneMessages);
  await expect(agentTab.locator('.tab-progress')).toHaveText('1/2');
  await expect(cards.first().locator('.tool-status-indicator.completed')).toHaveCount(1);
  await cards.first().locator('.task-header').click();
  await expect(cards.first()).toContainText('/root/review_one');
  await expect.poll(() => page.evaluate(() => (window as Window & { __agentBridgeMessages: string[] }).__agentBridgeMessages
    .filter(message => message.startsWith('load_subagent_session:')).map(message => JSON.parse(message.slice('load_subagent_session:'.length)))))
    .toContainEqual(expect.objectContaining({ agentId: 'child-one', agentPath: '/root/review_one', toolUseId: 'launch-one' }));
  await page.evaluate(() => window.onSubagentHistoryLoaded?.(JSON.stringify({ success: true, completed: true, status: 'completed',
    sessionId: 'agent-root', provider: 'codex', toolUseId: 'launch-one', agentId: 'child-one',
    latestTurnId: 'native-old-completed-turn', latestTurnStatus: 'completed', messages: [
      { type: 'assistant', raw: { message: { content: [{ type: 'thinking', thinking: 'Compared the module entry points' },
        { type: 'tool_use', id: 'read-one', name: 'Read', input: { file_path: '/src/module-one.ts' } }] } } },
      { type: 'assistant', raw: { codexPhase: 'final_answer', message: { content: [{ type: 'text', text: 'Review completed with two corrections' }] } } },
    ] })));
  await expect(cards.first()).toContainText('Compared the module entry points');
  await expect(cards.first()).toContainText('/src/module-one.ts');
  await expect(cards.first().locator('.subagent-result-card')).toHaveText('Review completed with two corrections');
  await expect(cards.first()).not.toContainText('{"task_name"');
  await expect(cards.first()).not.toContainText('opaque task transport');
  await agentTab.click();
  await expect(page.locator('.subagent-item')).toHaveCount(2);
  await expect(page.locator('.subagent-item.status-completed')).toHaveCount(1);
  await expect(page.locator('.subagent-item.status-running')).toHaveCount(1);
  await agentTab.click();

  const followupMessages = [...doneMessages,
    { type: 'assistant', content: '', raw: { uuid: 'followup-one', message: { content: [{ type: 'tool_use', id: 'followup-one',
      name: 'followup_task', input: { target: '/root/review_one' } }] } } },
    { type: 'user', content: '[tool_result]', raw: { uuid: 'followup-one-result', message: { content: [{ type: 'tool_result',
      tool_use_id: 'followup-one', content: '', is_error: false }] } } },
    { type: 'assistant', content: '', raw: { uuid: 'followup-one-activity', codexItemType: 'subAgentActivity', message: {
      content: [{ type: 'tool_use', id: 'followup-one-activity', name: 'subAgentActivity', input: {
        toolUseId: 'followup-one', kind: 'interacted', agentThreadId: 'child-one', agentPath: '/root/review_one',
      } }] } } },
  ];
  await page.evaluate(messages => window.updateMessages?.(JSON.stringify(messages)), followupMessages);
  await expect(cards.first().locator('.tool-status-indicator.pending')).toHaveCount(1);
  await expect(agentTab.locator('.tab-progress')).toHaveText('0/2');
  await expect(cards.first()).not.toContainText('Review completed with two corrections');
  await page.evaluate(() => window.onSubagentHistoryLoaded?.(JSON.stringify({ success: true, completed: true, status: 'completed',
    sessionId: 'agent-root', provider: 'codex', toolUseId: 'launch-one', messages: [
      { type: 'assistant', raw: { message: { content: [{ type: 'text', text: 'Late previous report' }] } } },
    ] })));
  await expect(cards.first()).not.toContainText('Late previous report');
  await expect(cards.first().locator('.tool-status-indicator.pending')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => (window as Window & { __agentBridgeMessages: string[] }).__agentBridgeMessages
    .filter(message => message.startsWith('load_subagent_statuses:'))
    .some(message => JSON.parse(message.slice('load_subagent_statuses:'.length)).agents.some((agent: { nativeTaskId?: string; nativeTaskPreviousTurnId?: string }) =>
      agent.nativeTaskId === 'followup-one' && agent.nativeTaskPreviousTurnId === 'native-old-completed-turn'))))
    .toBe(true);
  const nativeRead = (turnId: string, report: string) => async (method: string, params: { threadId: string }) => {
    if (method === 'thread/read') return { thread: { id: params.threadId, parentThreadId: 'agent-root', status: { type: 'idle' } } };
    if (method === 'thread/turns/list') return { data: [{ id: turnId, status: 'completed', itemsView: 'full',
      items: [{ id: `${turnId}-report`, type: 'agentMessage', text: report }] },
      ...(turnId !== 'native-old-completed-turn' ? [{ id: 'native-old-completed-turn', status: 'completed', itemsView: 'full',
        items: [{ id: 'previous-final-answer', type: 'agentMessage', text: 'Previous native final answer', phase: 'final_answer' }] }] : [])], nextCursor: null };
    throw new Error(`Unexpected child read: ${method}`);
  };
  const followupRequest = await page.evaluate(() => (window as Window & { __agentBridgeMessages: string[] }).__agentBridgeMessages
    .filter(message => message.startsWith('load_subagent_session:'))
    .map(message => JSON.parse(message.slice('load_subagent_session:'.length)))
    .findLast(request => request.nativeTaskId === 'followup-one'));
  expect(followupRequest).toMatchObject({ nativeTaskPreviousTurnId: 'native-old-completed-turn' });
  for (let poll = 0; poll < 2; poll += 1) {
    const staleNativeRead = await readNativeSubagent(nativeRead('native-old-completed-turn', 'Old native report read by the new request'), {
      ...followupRequest, rootThreadId: 'agent-root', includeHistory: true,
    });
    await page.evaluate(result => window.onSubagentHistoryLoaded?.(JSON.stringify(result)), { ...followupRequest, ...staleNativeRead });
    await expect(cards.first()).not.toContainText('Old native report read by the new request');
    await expect(cards.first().locator('.tool-status-indicator.pending')).toHaveCount(1);
    await expect(agentTab.locator('.tab-progress')).toHaveText('0/2');
    expect(staleNativeRead.nativeTaskPreviousTurnId).toBe('native-old-completed-turn');
  }
  const newNativeRead = await readNativeSubagent(nativeRead('e5c7e7fb-0a30-4f61-bd1a-26c1fbf92cd9', 'Followup report completed'), {
    ...followupRequest, rootThreadId: 'agent-root', includeHistory: true,
  });
  expect(newNativeRead.nativeTaskPreviousTurnId).toBeNull();
  await page.evaluate(result => window.onSubagentHistoryLoaded?.(JSON.stringify(result)), { ...followupRequest, ...newNativeRead });
  await expect(cards.first().locator('.subagent-result-card')).toHaveText('Followup report completed');
  await expect(cards.first().locator('.tool-status-indicator.completed')).toHaveCount(1);
  const finalMessages = [...followupMessages, { type: 'assistant', content: '', raw: { uuid: 'followup-done', codexItemType: 'subAgentActivity',
    message: { content: [{ type: 'tool_use', id: 'followup-done', name: 'subAgentActivity', input: {
      kind: 'completed', agentThreadId: 'child-one', agentPath: '/root/review_one',
    } }] } } }];
  await page.evaluate(messages => window.updateMessages?.(JSON.stringify(messages)), finalMessages);
  await page.evaluate(messages => {
    window.onStreamEnd?.();
    window.beginCodexHistoryPage?.(JSON.stringify({ pageId: 'agents', sessionId: 'agent-root', mode: 'replace' }));
    window.appendCodexHistoryPageBatch?.('agents', JSON.stringify(messages));
    window.completeCodexHistoryPage?.(JSON.stringify({ pageId: 'agents', sessionId: 'agent-root', mode: 'replace', source: 'native',
      cursor: null, hasMore: false, fromTurn: 0, toTurn: 1, totalTurns: 1, loadedMessageCount: messages.length }));
  }, finalMessages);
  await expect(cards).toHaveCount(2);
  await expect(cards.first().locator('.tool-status-indicator.completed')).toHaveCount(1);
  await expect(agentTab.locator('.tab-progress')).toHaveText('1/2');
  await page.screenshot({ path: `../.workflow/codex-subagent-cards-${testInfo.project.name}.png` });
});

test('Codex actual subagent records restore both launched children without raw receipts or activity cards', async ({ page }, testInfo) => {
  const fixturePath = process.env.CODEX_SUBAGENT_CARDS_FIXTURE;
  test.skip(!fixturePath, 'The private actual-conversation fixture is supplied only during a local audit.');
  const messages = JSON.parse(readFileSync(fixturePath!, 'utf8')) as Array<{ type: string; content?: string;
    raw?: { codexThreadId?: string; content?: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> } }>;
  const launches = messages.flatMap(message => (message.raw?.content ?? []).filter(block => block.type === 'tool_use' && block.name === 'spawn_agent'));
  const states = new Map<string, string>();
  const followups = new Set(messages.flatMap(message => (message.raw?.content ?? [])
    .filter(block => block.type === 'tool_use' && block.name === 'followup_task').map(block => block.id)));
  for (const message of messages) for (const block of message.raw?.content ?? []) {
    if (block.name === 'subAgentActivity' && typeof block.input?.agentThreadId === 'string') {
      if (block.input.kind === 'interacted' && followups.has(String(block.input.toolUseId))) states.set(block.input.agentThreadId, 'running');
      else if (block.input.kind !== 'interacted') states.set(block.input.agentThreadId, String(block.input.kind));
    }
  }
  expect(launches).toHaveLength(2);
  expect(states.size).toBe(2);
  const completed = [...states.values()].filter(kind => kind === 'completed').length;
  const sessionId = messages.find(message => message.raw?.codexThreadId)?.raw?.codexThreadId ?? 'actual-agent-root';
  await page.evaluate(({ messages, sessionId }) => {
    window.setSessionId?.(sessionId);
    window.beginCodexHistoryPage?.(JSON.stringify({ pageId: 'actual-agents', sessionId, mode: 'replace' }));
    window.appendCodexHistoryPageBatch?.('actual-agents', JSON.stringify(messages));
    window.completeCodexHistoryPage?.(JSON.stringify({ pageId: 'actual-agents', sessionId, mode: 'replace', source: 'native',
      cursor: null, hasMore: false, fromTurn: 0, toTurn: 1, totalTurns: 1, loadedMessageCount: messages.length }));
  }, { messages, sessionId });
  const cards = page.locator('.agent-group-container');
  await expect(cards).toHaveCount(2);
  await expect(cards.locator('.tool-status-indicator.completed')).toHaveCount(completed);
  await expect(page.locator('.status-panel-tab').nth(1).locator('.tab-progress')).toHaveText(`${completed}/2`);
  await expect(page.locator('.tool-title-text', { hasText: 'spawn_agent' })).toHaveCount(0);
  await expect(page.locator('.tool-title-text', { hasText: 'subAgentActivity' })).toHaveCount(0);
  for (const launch of launches) await expect(page.locator('.agent-group-container', { hasText: String(launch.input?.task_name) })).toHaveCount(1);
  await cards.first().locator('.task-header').click();
  await expect(cards.first()).not.toContainText('{"task_name"');
  await expect(cards.first().locator('.subagent-process-subtitle')).toHaveCount(2);
  await page.screenshot({ path: `../.workflow/codex-subagent-actual-${testInfo.project.name}.png` });
});
