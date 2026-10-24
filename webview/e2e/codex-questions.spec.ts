import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';
import { projectCodexItemMessages } from '../../ai-bridge/services/codex/codex-item-projection.js';

type QuestionWindow = Window & { __questionMessages: string[] };
const threadId = 'question-thread';
const questionItem = { type: 'agentMessage', id: 'native-question', delivery: 'async',
  text: 'Choose a test answer.\n\n- A\n- B\n- C',
  questions: [{ title: 'Choose a test answer.', options: ['A', 'B', 'C'] }] };
const questions = [{ id: 'question-1', question: 'Choose a test answer.', header: '',
  multiSelect: false, options: ['A', 'B', 'C'].map(label => ({ label, description: '' })) }];
const event = { kind: 'interactionRequested', threadId, rootThreadId: threadId, channelId: 'question-channel',
  interactionKey: 'native-question-key', dialogToken: 'native-question-token', deliverySequence: 1,
  payload: { method: 'item/agentMessage/requestUserInput', params: { threadId, turnId: 'question-turn',
    itemId: questionItem.id, isBlocking: false, questions } } };

function messages(items: Record<string, unknown>[]) {
  return items.flatMap(item => projectCodexItemMessages(item, { threadId, turnId: 'question-turn', authoritative: true }))
    .map(raw => ({ type: raw.type, raw, timestamp: '2026-10-21T12:00:00Z',
      content: raw.message.content.filter((block: { type: string }) => block.type === 'text')
        .map((block: { text: string }) => block.text).join('\n') }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(version => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'codex', codexModel: 'gpt-6.1' }));
    localStorage.setItem('language', 'zh');
    window.__pendingSessionId = 'question-thread';
    const bridge = window as QuestionWindow;
    bridge.__questionMessages = [];
    window.sendToJava = message => {
      bridge.__questionMessages.push(message);
      if (message.startsWith('get_dependency_status:')) setTimeout(() => window.updateDependencyStatus?.(JSON.stringify({
        'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
        'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
      })), 0);
    };
  }, APP_VERSION);
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await expect(page.locator('.button-area').first()).toHaveAttribute('data-provider', 'codex');
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
});

async function openQuestion(page: Page) {
  await page.evaluate(({ transcript, request }) => {
    window.updateMessages?.(JSON.stringify(transcript));
    window.onCodexRuntimeEvent?.(JSON.stringify(request));
    window.onCodexRuntimeEvent?.(JSON.stringify(request));
  }, { transcript: messages([questionItem]), request: event });
  const dialog = page.locator('.ask-user-question-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(1);
  return dialog;
}

test('async choices use the bottom dialog and display the selected answer after history reload', async ({ page }) => {
  await page.evaluate(() => { window.onStreamStart?.(); window.showLoading?.('true'); });
  const dialog = await openQuestion(page);
  const viewport = page.viewportSize()!;
  // Wait for the bottom entrance animation before checking the final bounds.
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    return box ? Math.abs(viewport.height - box.y - box.height - 8) : Infinity;
  }).toBeLessThan(1);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeLessThanOrEqual(12);
  expect(bounds!.width).toBeGreaterThan(viewport.width - 30);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  expect(viewport.height - bounds!.y - bounds!.height).toBeLessThanOrEqual(12);
  await dialog.getByText('B', { exact: true }).click();
  await dialog.locator('.action-button.primary').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.stop-button')).toBeVisible();
  const replies = await page.evaluate(() => (window as QuestionWindow).__questionMessages
    .filter(message => message.startsWith('codex_interaction_response:')));
  expect(replies).toHaveLength(1);
  expect(JSON.parse(replies[0].slice('codex_interaction_response:'.length))).toMatchObject({
    interactionKey: 'native-question-key', result: { answers: { 'question-1': { answers: ['B'] } } },
  });
  const transcript = messages([questionItem,
    { type: 'sleep', id: 'wait-for-answer', durationMs: 60000 },
    { type: 'userMessage', id: 'answer', content: [{ type: 'text', text:
      'Answers to your questions (request: native-question):\n\nChoose a test answer.\nB' }] },
    { type: 'agentMessage', id: 'final', text: 'Selected answer: B' }]);
  await page.evaluate(value => {
    window.updateMessages?.(JSON.stringify(value)); window.onStreamEnd?.(); window.showLoading?.('false');
  }, transcript);
  await expect(page.locator('.codex-question-record-answer')).toHaveText(/B/);
  await expect(page.getByText('Answers to your questions', { exact: false })).toHaveCount(0);
  await expect(page.locator('.tool-status-indicator.error')).toHaveCount(0);
  await expect(page.getByText('sleep', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Selected answer: B', { exact: true })).toBeVisible();
  await expect(page.locator('.stop-button')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.input-editable')).toBeVisible();
  await page.evaluate(value => window.updateMessages?.(JSON.stringify(value)), transcript);
  await expect(page.locator('.codex-question-record-answer')).toHaveText(/B/);
  await expect(page.getByText('Answers to your questions', { exact: false })).toHaveCount(0);
  await expect(page.locator('.ask-user-question-dialog')).toHaveCount(0);
});

test('configuration warnings retain details and do not prevent custom answers', async ({ page }) => {
  const dialog = await openQuestion(page);
  await page.evaluate(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning',
    threadId: 'question-thread', payload: { method: 'configWarning',
      message: 'Codex is ignoring old settings.\ndisable_response_storage is ignored.\nnetwork_access is ignored.' } })));
  await expect(page.locator('.toast-message')).not.toContainText('disable_response_storage');
  await page.locator('.toast-action').click();
  await expect(page.locator('.ant-modal-confirm-content')).toContainText('disable_response_storage is ignored.');
  await page.locator('.ant-modal-confirm-btns button').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('textarea').fill('A custom answer');
  await dialog.locator('.action-button.primary').click();
  const replies = await page.evaluate(() => (window as QuestionWindow).__questionMessages
    .filter(message => message.startsWith('codex_interaction_response:')));
  expect(JSON.parse(replies[0].slice('codex_interaction_response:'.length))).toMatchObject({
    result: { answers: { 'question-1': { answers: ['A custom answer'] } } },
  });
});

test('legacy rollout restoration keeps the question transcript and selected answer without reopening its dialog', async ({ page }) => {
  const transcript = [
    { type: 'assistant', content: 'Tool: codex_user_input', raw: { codexThreadId: threadId, codexTurnId: 'old-turn',
      codexItemId: 'native-question', codexItemType: 'agentMessage', codexAuthoritative: true,
      content: [{ type: 'tool_use', id: 'native-question', name: 'codex_user_input', input: { questions } }] } },
    { type: 'user', content: 'Answers to your questions (request: native-question):\n\nChoose a test answer.\nB', raw: {
      codexThreadId: threadId, codexItemType: 'userMessage', content: [{ type: 'text',
        text: 'Answers to your questions (request: native-question):\n\nChoose a test answer.\nB' }] } },
    { type: 'assistant', content: 'Selected answer: B' },
  ];
  await page.evaluate(value => { window.updateMessages?.(JSON.stringify(value)); window.onStreamEnd?.(); }, transcript);
  await expect(page.locator('.codex-question-record-answer')).toHaveText(/B/);
  await expect(page.getByText('Answers to your questions', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Request User Input Async', { exact: true })).toHaveCount(1);
  await expect(page.locator('.ask-user-question-dialog')).toHaveCount(0);
  await expect(page.locator('.tool-status-indicator.error')).toHaveCount(0);
});

test('questions use the original tool row and plain message layout across viewports', async ({ page }, testInfo) => {
  const transcript = messages([{ ...questionItem, questions: [
    { title: '请选择一个**测试答案**，我会在收到后打印 `config.toml` 中的选项。', options: [
      'A — 使用现有配置，保留当前设置。',
      'B — 使用另一种配置；这段较长的选项说明在窄窗口中应当自然换行。',
      'C',
    ] },
    { title: '还有其他需要补充的内容吗？', options: [] },
  ] }]);
  await page.evaluate(value => window.updateMessages?.(JSON.stringify(value)), transcript);
  const record = page.locator('.codex-question-record');
  await expect(record).toBeVisible();
  await expect(record.locator('.tool-title-text')).toHaveText('Request User Input Async');
  await expect(record.getByText('Codex 提问', { exact: true })).toHaveCount(0);
  await expect(record.locator('.markdown-content strong')).toHaveText('测试答案');
  await expect(record.locator('.markdown-content code')).toHaveText('config.toml');
  await expect(record.getByRole('listitem')).toHaveText([
    'A — 使用现有配置，保留当前设置。',
    'B — 使用另一种配置；这段较长的选项说明在窄窗口中应当自然换行。',
    'C',
  ]);
  await expect(record).toHaveCSS('border-top-width', '0px');
  await expect(record).toHaveCSS('padding-left', '0px');
  const list = record.getByRole('list');
  const firstOption = record.getByRole('listitem').first();
  const listBounds = await list.boundingBox();
  const optionBounds = await firstOption.boundingBox();
  expect(optionBounds!.x).toBeGreaterThan(listBounds!.x);
  expect(await record.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(record.locator('.tool-status-indicator.error')).toHaveCount(0);
  await expect(page.locator('.ask-user-question-dialog')).toHaveCount(0);
  await record.screenshot({ path: testInfo.outputPath('codex-question-legacy-style.png') });
});

test('completed native edits retain a successful receipt when the stream ends', async ({ page }) => {
  const transcript = messages([
    { type: 'userMessage', id: 'edit-prompt', content: [{ type: 'text', text: 'Update the test note.' }] },
    { type: 'fileChange', id: 'edit-note', status: 'completed',
      changes: [{ path: 'ccqa-note.txt', kind: { type: 'update' }, diff: '@@ -1,1 +1,1 @@\n-Count=8\n+Count=9' }],
      stdout: 'Success. Updated the following files:\nM ccqa-note.txt', stderr: '' },
    { type: 'agentMessage', id: 'edit-done', text: 'Count updated to 9.' },
  ]);
  await page.evaluate(value => {
    window.onStreamStart?.(); window.updateMessages?.(JSON.stringify(value)); window.onStreamEnd?.(); window.showLoading?.('false');
  }, transcript);
  await expect(page.locator('.file-changes-tool-block .tool-status-indicator.completed')).toHaveCount(1);
  await expect(page.locator('.tool-status-indicator.error')).toHaveCount(0);
  await expect(page.getByText('Count updated to 9.', { exact: true })).toBeVisible();
});

test('ordinary chat stays usable through native notices and refreshes edits without full hydration', async ({ page }) => {
  await page.evaluate(value => {
    window.updateMessages?.(JSON.stringify(value));
    window.onStreamStart?.(); window.showLoading?.('true');
    for (const method of ['configWarning', 'deprecationNotice']) window.onCodexRuntimeEvent?.(JSON.stringify({
      kind: 'nativeWarning', threadId: 'question-thread', payload: { method,
        message: method === 'configWarning' ? 'Old setting is ignored.' : 'Full-history hydration is deprecated for paginated threads.' },
    }));
  }, messages([{ type: 'userMessage', id: 'hello', content: [{ type: 'text', text: '你好' }] }]));
  await expect(page.locator('.ask-user-question-dialog')).toHaveCount(0);
  await expect(page.locator('.stop-button')).toBeVisible();
  await expect(page.locator('.toast-message')).toHaveCount(2);
  await expect(page.locator('.toast-message').last()).toHaveText('Codex 返回接口兼容提示，可查看详情。');
  await page.locator('.toast-action').last().click();
  await expect(page.locator('.ant-modal-confirm-content')).toContainText('Full-history hydration is deprecated');
  await page.locator('.ant-modal-confirm-btns button').click();
  await page.evaluate(value => {
    window.updateMessages?.(JSON.stringify(value)); window.onStreamEnd?.(); window.showLoading?.('false');
  }, messages([{ type: 'userMessage', id: 'hello', content: [{ type: 'text', text: '你好' }] },
    { type: 'agentMessage', id: 'greeting', text: '你好，有什么可以帮你？' }]));
  await expect(page.getByText('你好，有什么可以帮你？', { exact: true })).toBeVisible();
  await expect(page.locator('.stop-button')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => (window as QuestionWindow).__questionMessages
    .filter(message => message.startsWith('codex_native_read_thread:')).length)).toBeGreaterThan(0);
  const reads = await page.evaluate(() => (window as QuestionWindow).__questionMessages
    .filter(message => message.startsWith('codex_native_read_thread:'))
    .map(message => JSON.parse(message.slice('codex_native_read_thread:'.length))));
  expect(reads.every(read => read.params.fileChangesOnly === true && read.params.includeTurns !== true)).toBe(true);
});
