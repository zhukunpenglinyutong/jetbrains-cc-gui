import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from '../webview/node_modules/typescript/lib/typescript.js';

const labelSource = await readFile(resolve('webview/src/nativeMarkdownAnnotations/labels.ts'), 'utf8');
const labelModule = ts.transpileModule(labelSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { previewLabels } = await import('data:text/javascript;base64,' + Buffer.from(labelModule).toString('base64'));
let nativeLabels = previewLabels('en');

// Connect only to the isolated runIde harness, never to a user's normal IDE.
const folder = resolve('build/native-markdown-smoke');
const stateFile = resolve(folder, 'state.json');
const initialState = JSON.parse(await readFile(stateFile, 'utf8'));
if (!initialState.port) throw new Error('The IDE smoke harness has not opened JCEF yet.');
// JCEF does not implement Chromium browser-context/download APIs used by
// Playwright connectOverCDP. Use the standard page CDP endpoints directly.
class Page {
  constructor(target) {
    this.target = target;
    this.socket = new WebSocket(target.webSocketDebuggerUrl);
    this.sequence = 0; this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve; this.socket.onerror = reject;
    });
    this.socket.onmessage = event => {
      const response = JSON.parse(event.data);
      const callback = this.callbacks.get(response.id);
      if (callback) {
        this.callbacks.delete(response.id);
        response.error ? callback.reject(new Error(response.error.message)) : callback.resolve(response.result);
      }
    };
  }
  url() { return this.target.url; }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(callback, argument) {
    const result = await this.send('Runtime.evaluate', {
      expression: '(' + callback.toString() + ')(' + JSON.stringify(argument ?? null) + ')',
      returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Page evaluation failed');
    return result.result.value;
  }
  locator(selector, name) {
    if (name && this.url().includes('/markdownPreview/')) {
      const key = Object.keys(previewLabels('en')).find(key => previewLabels('en')[key] === name);
      if (key) name = nativeLabels[key];
      else if (/^\d+ comments$/.test(name)) name = name.split(' ')[0] + ' ' + nativeLabels.comments;
    }
    const evaluate = (callback, argument) => this.evaluate(({ selector, name, callback, argument }) => {
      const element = [...document.querySelectorAll(selector)].find(item => name === undefined || item.textContent.trim() === name || item.getAttribute('aria-label') === name);
      if (!element) throw new Error('Element missing: ' + selector + ' / ' + name);
      return (new Function('element', 'argument', 'return (' + callback + ')(element, argument)'))(element, argument);
    }, { selector, name, callback: callback.toString(), argument });
    return {
      evaluate: callback => evaluate(callback),
      click: () => evaluate(element => { if (element.disabled) throw new Error('Button disabled'); element.click(); }),
      fill: text => evaluate((element, text) => { element.focus(); element.value = text; element.dispatchEvent(new Event('input', { bubbles: true })); }, text),
      textContent: () => evaluate(element => element.textContent),
      count: () => this.evaluate(selector => document.querySelectorAll(selector).length, selector),
    };
  }
  getByRole(role, options) { return this.locator(role === 'textbox' ? 'textarea' : 'button', options?.name); }
  waitForSelector(selector) { return poll(() => this.locator(selector).count(), 'Element did not appear: ' + selector); }
  async screenshot({ path }) {
    const image = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(image.data, 'base64'));
  }
}
const connections = new Map();
const pages = async () => {
  const targets = await fetch('http://127.0.0.1:' + initialState.port + '/json/list').then(response => response.json());
  return targets.filter(target => target.type === 'page').map(target => {
    if (!connections.has(target.id)) connections.set(target.id, new Page(target));
    return connections.get(target.id);
  });
};
const initialPages = await pages();
const preview = initialPages.find(page => page.url().includes('/markdownPreview/'));
const chat = initialPages.find(page => page.url().includes('jbcefbrowser'));
if (!preview || !chat) throw new Error('Expected native Markdown and CC GUI pages.');
nativeLabels = previewLabels(await preview.evaluate(() => document.querySelector('#ccgui-markdown-review')?.lang || navigator.language));
const report = { checks: [], metadata: {}, errors: [] };
const check = (name, condition) => {
  if (!condition) throw new Error(name);
  report.checks.push(name);
  console.log('PASS ' + name);
};
const poll = async (callback, message) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await callback()) return;
    await new Promise(done => setTimeout(done, 250));
  }
  throw new Error(message);
};
const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'));
const storedReviews = async () => {
  const xml = await readFile(resolve(folder, '.idea/workspace.xml'), 'utf8');
  const encoded = /name="encodedPayload" value="([A-Za-z0-9+/=]+)"/.exec(xml)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : xml;
};
const command = async payload => {
  const id = 'smoke-' + Date.now();
  await writeFile(resolve(folder, 'command.json'), JSON.stringify({ id, ...payload }));
  await poll(async () => (await readState()).commandId === id, 'IDE did not process test command');
};
const selectParagraph = async (page, text, formatted = false) => page.evaluate(({ text, formatted }) => {
  const paragraph = [...document.querySelectorAll('p')].find(element => element.textContent.includes(text));
  if (!paragraph) throw new Error('Test paragraph missing');
  const range = document.createRange();
  if (formatted) {
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.textContent.includes('with')) {}
    if (!node) throw new Error('Formatted selection start missing');
    range.setStart(node, node.textContent.indexOf('with'));
    const bold = document.createTreeWalker(paragraph.querySelector('strong'), NodeFilter.SHOW_TEXT).nextNode();
    range.setEnd(bold, bold.textContent.length);
  } else {
    range.selectNodeContents(paragraph);
  }
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
}, { text, formatted });

const configureReview = async (key, value) => {
  await chat.evaluate(({ key, value }) => window.sendToJava('set_markdown_review_config:' + JSON.stringify({ [key]: value })), { key, value });
  await poll(async () => (await readState()).reviews.config[key] === value, 'Review preference was not applied: ' + key);
};

if (process.argv.includes('--multi-block')) {
  try {
    await chat.waitForSelector('.input-editable');
    await configureReview('enabled', true);
    await configureReview('persist', false);
    await configureReview('autoAddToChat', true);
    await configureReview('submitShortcut', 'enter');
    while ((await readState()).reviews.annotations.length) {
      const count = (await readState()).reviews.annotations.length;
      await preview.getByRole('button', { name: count + ' comments' }).click();
      await preview.getByRole('button', { name: 'Delete' }).click();
      await poll(async () => (await readState()).reviews.annotations.length < count, 'Could not clear prior comments');
    }
    const markdown = '# 跨列表批注回归\n\n'
      + '1. 缓存的idex/url等信息，应保存到数据库中，包括gpx\n'
      + '2. 增加允许导入导出数据库的功能\n'
      + '3. 数据库引入**应用版本管理**，支持根据新的数据架构自动升级\n'
      + '4. 其他项目\n\n- [x] 已修复 **GPS** 问题\n- [ ] 检查结果\n';
    await command({ replace: markdown });
    await poll(async () => await preview.evaluate(() => document.querySelectorAll('ol li').length === 4
      && !document.querySelector('.ccgui-md-controls [role="status"]')), 'New native list did not settle');
    const selectItems = async (selector, endIndex) => preview.evaluate(({ selector, endIndex }) => {
      const items = [...document.querySelectorAll(selector)];
      const texts = element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const result = []; let node;
        while ((node = walker.nextNode())) result.push(node);
        return result;
      };
      const start = texts(items[0])[0]; const end = texts(items[endIndex]).at(-1);
      const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, end.length);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
      return range.toString();
    }, { selector, endIndex });
    report.metadata.quotation = await selectItems('ol li', 2);
    await preview.getByRole('button', { name: 'Comment' }).click();
    await preview.getByRole('textbox').fill('检查这三项是否完成');
    await preview.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await preview.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === '检查这三项是否完成'),
      'Cross-list comment rejected by native source validation');
    const annotation = (await readState()).reviews.annotations.find(item => item.comment === '检查这三项是否完成');
    check('cross-list selection saves the exact quotation and all three Markdown source items',
      annotation.selectedText === report.metadata.quotation && annotation.sourceContext.includes('1. 缓存')
      && annotation.sourceContext.includes('3. 数据库') && annotation.sourceContext.includes('**应用版本管理**')
      && annotation.precision === 'block');
    await poll(async () => (await readState()).reviews.batches.some(item => item.state === 'received'
      && item.annotations.some(entry => entry.id === annotation.id)), 'Cross-list draft did not receive an ACK');
    check('cross-list comment reaches the expanded chat draft', await chat.locator('.artifact-review-drafts[open]').count() === 1);
    await selectItems('ol li', 2);
    await preview.getByRole('button', { name: 'Quote to CC GUI' }).click();
    await poll(async () => (await readState()).reviews.batches.some(item => item.kind === 'quote' && item.state === 'received'
      && item.annotations[0].selectedText === report.metadata.quotation), 'Cross-list quote was not received');
    check('cross-list direct quotation uses the same validated source range', true);
    await selectItems('ul li', 1);
    await preview.getByRole('button', { name: 'Comment' }).click();
    await preview.getByRole('textbox').fill('核对复选列表');
    await preview.getByRole('button', { name: 'Add comment' }).click();
    await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === '核对复选列表'),
      'Cross-checkbox comment rejected');
    check('checkbox lists and formatted inline text also submit across items', true);
    await chat.screenshot({ path: resolve(folder, 'multi-block-chat.png') });
    await configureReview('autoAddToChat', false);
  } catch (error) { report.errors.push(error.message); console.error(error); process.exitCode = 1; }
  await writeFile(resolve(folder, 'multi-block-report.json'), JSON.stringify(report, null, 2));
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--auto-draft-ui')) {
  try {
    await chat.waitForSelector('.artifact-review-drafts summary');
    await chat.locator('.artifact-review-drafts summary').click();
    const location = await chat.locator('.artifact-review-reference').evaluate(element => {
      const label = element.querySelector('small');
      const card = element.closest('article').getBoundingClientRect();
      return { text: label.textContent, right: label.getBoundingClientRect().right, midpoint: card.left + card.width / 2 };
    });
    check('real chat draft shows filename prefix and start:end lines on the right',
      /^review\.md \d+:\d+$/.test(location.text) && location.right > location.midpoint);
    check('draft no longer shows positioned/source-block metadata',
      !/已定位|原文块/.test(await chat.locator('.artifact-review-drafts').textContent()));
    await chat.screenshot({ path: resolve(folder, 'auto-add-chat-draft.png') });
  } catch (error) { report.errors.push(error.message); console.error(error); process.exitCode = 1; }
  await writeFile(resolve(folder, 'auto-draft-ui-report.json'), JSON.stringify(report, null, 2));
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--auto-add') || process.argv.includes('--auto-add-from-settings')) {
  try {
    await chat.waitForSelector('.input-editable');
    await configureReview('enabled', true);
    await configureReview('persist', false);
    await configureReview('autoAddToChat', false);
    const oldTarget = (await readState()).chatTargetId;
    await command({ newChat: true });
    await poll(async () => (await readState()).chatTargetId !== oldTarget, 'New test chat was not created');
    const target = (await readState()).chatTargetId;
    while ((await readState()).reviews.annotations.length) {
      const count = (await readState()).reviews.annotations.length;
      await preview.getByRole('button', { name: count + ' comments' }).click();
      await preview.getByRole('button', { name: 'Delete' }).click();
      await poll(async () => (await readState()).reviews.annotations.length < count, 'Could not clear prior comments');
    }
    const original = await readFile(resolve(folder, 'review.md'), 'utf8');
    await command({ replace: original });
    await poll(async () => await preview.evaluate(() => document.body.textContent.includes('Second paragraph')
      && !document.querySelector('.ccgui-md-controls [role="status"]')), 'Native preview did not settle');
    const add = async (paragraph, comment) => {
      await selectParagraph(preview, paragraph);
      await preview.getByRole('button', { name: 'Comment' }).click();
      await preview.getByRole('textbox').fill(comment);
      await preview.getByRole('button', { name: 'Add comment' }).click();
      await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === comment), 'Comment missing: ' + comment);
    };
    await add('First paragraph', 'manual-only');
    check('default-off auto add keeps new comments out of chat input',
      (await readState()).reviews.batches.every(item => item.targetId !== target)
      && await chat.locator('.artifact-review-drafts').count() === 0);
    await configureReview('autoAddToChat', true);
    const fromSettings = process.argv.includes('--auto-add-from-settings');
    if (fromSettings) {
      await configureReview('submitShortcut', 'enter');
      await chat.evaluate(() => document.querySelector('.header .codicon-settings-gear')?.closest('button')?.click());
      await poll(async () => await chat.locator('.input-editable').count() === 0, 'Settings did not unmount chat input');
      await selectParagraph(preview, 'Second paragraph');
      await preview.getByRole('button', { name: 'Comment' }).click();
      await preview.getByRole('textbox').fill('auto: initial');
      await preview.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await preview.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    } else await add('Second paragraph', 'auto: initial');
    await poll(async () => (await readState()).reviews.batches.some(item => item.targetId === target
      && item.automatic && item.state === 'received'), 'Automatic review did not arrive');
    await chat.waitForSelector('.artifact-review-drafts');
    await poll(async () => await chat.locator('.artifact-review-drafts').textContent().then(text => text.includes('auto: initial')),
      'Chat input did not display automatic review');
    check('enabled switch adds a new comment directly to selected chat draft without sending',
      await chat.locator('.artifact-review-drafts').count() === 1
      && (await readState()).reviews.batches.filter(item => item.targetId === target && item.automatic && item.state === 'received').length === 1);
    if (fromSettings) {
      check('Enter submits from native preview and Settings switches back to mounted chat',
        await chat.locator('.input-editable').count() === 1
        && await chat.locator('.artifact-review-drafts[open]').count() === 1);
      await configureReview('submitShortcut', 'ctrlEnter');
      await chat.evaluate(() => document.querySelector('.header .codicon-settings-gear')?.closest('button')?.click());
      await poll(async () => await chat.locator('.input-editable').count() === 0, 'Settings did not reopen');
    }
    await preview.locator('.ccgui-md-marker[title="auto: initial"]').click();
    await preview.getByRole('button', { name: 'Edit' }).click();
    await preview.getByRole('textbox').fill('auto: edited');
    if (fromSettings) {
      await preview.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13 });
      await preview.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 2, windowsVirtualKeyCode: 13 });
    } else await preview.getByRole('button', { name: 'Save' }).click();
    await poll(async () => (await readState()).reviews.batches.some(item => item.targetId === target
      && item.automatic && item.state === 'received' && item.annotations[0].comment === 'auto: edited'),
    'Edited automatic review did not arrive');
    await poll(async () => await chat.locator('.artifact-review-drafts').textContent().then(text => text.includes('auto: edited') && !text.includes('auto: initial')),
      'Chat draft did not supersede old automatic review');
    check('editing supersedes the unsent automatic draft and keeps the earlier snapshot terminal',
      (await readState()).reviews.batches.some(item => item.targetId === target && item.automatic && item.state === 'removed')
      && await chat.locator('.artifact-review-drafts article').count() === 1);
    if (fromSettings) check('Ctrl+Enter saves the edit from Settings and restores one updated draft',
      await chat.locator('.input-editable').count() === 1
      && await chat.locator('.artifact-review-drafts[open]').count() === 1);
    await configureReview('autoAddToChat', false);
    await command({ save: true });
    check('auto add preference can be switched off again', (await readState()).reviews.config.autoAddToChat === false);
  } catch (error) { report.errors.push(error.message); console.error(error); process.exitCode = 1; }
  await writeFile(resolve(folder, process.argv.includes('--auto-add-from-settings') ? 'settings-handoff-report.json' : 'auto-add-report.json'), JSON.stringify(report, null, 2));
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--review-policy-restart')) {
  try {
    await chat.waitForSelector('.input-editable');
    const restored = (await readState()).reviews;
    check('restart keeps review preferences while dropping transient comments and snapshots',
      restored.config.persist === false && restored.config.enabled === false && restored.config.autoDeleteAffected === false
      && restored.annotations.length === 0 && restored.batches.length === 0);
    check('restarted disabled preview has no visible annotation UI', await preview.evaluate(() =>
      document.querySelector('#ccgui-markdown-review')?.hidden === true));
    await configureReview('enabled', true);
    check('annotations can be enabled again without reopening the native preview', await preview.evaluate(() =>
      document.querySelector('#ccgui-markdown-review')?.hidden === false));
  } catch (error) { report.errors.push(error.message); process.exitCode = 1; }
  await writeFile(resolve(folder, 'policy-restart-report.json'), JSON.stringify(report, null, 2));
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--review-policy')) {
  try {
    await chat.waitForSelector('.input-editable');
    await configureReview('enabled', true);
    await configureReview('persist', false);
    await configureReview('autoDeleteAffected', true);
    const original = await readFile(resolve(folder, 'review.md'), 'utf8');
    const settled = async text => poll(async () => await preview.evaluate(text =>
      document.body.textContent.includes(text) && !document.querySelector('.ccgui-md-controls [role="status"]'), text),
    'Native preview did not settle');
    while ((await readState()).reviews.annotations.length) {
      const count = (await readState()).reviews.annotations.length;
      await preview.getByRole('button', { name: count + ' comments' }).click();
      await preview.getByRole('button', { name: 'Delete' }).click();
      await poll(async () => (await readState()).reviews.annotations.length < count, 'Could not clear previous policy test comments');
    }
    await command({ replace: original });
    await settled('Second paragraph');
    const addComment = async (text, comment, formatted = false) => {
      await selectParagraph(preview, text, formatted);
      await poll(async () => await preview.evaluate(() => [...document.querySelectorAll('.ccgui-md-toolbar button')]
        .some(button => !button.closest('.ccgui-md-toolbar').hidden)), 'Selection toolbar did not appear');
      await preview.getByRole('button', { name: 'Comment' }).click();
      await preview.getByRole('textbox').fill(comment);
      await preview.getByRole('button', { name: 'Add comment' }).click();
      await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === comment), 'Comment was not created');
    };
    await addComment('Second paragraph', 'policy: fix this paragraph; explicitly report unfinished requirements');
    await preview.getByRole('button', { name: 'Add to CC GUI' }).click();
    await poll(async () => (await readState()).reviews.batches.some(batch => batch.state === 'received'), 'Draft was not received');
    const batch = (await readState()).reviews.batches.find(batch => batch.annotations.some(item => item.comment.startsWith('policy:')));
    await addComment('First paragraph', 'policy: keep this unchanged block', true);
    const before = (await readState()).reviews.annotations.find(item => item.comment.includes('fix this paragraph')).start;
    await command({ prepend: 'Policy header\n\n' });
    await settled('Policy header');
    check('inserting before annotated text relocates and retains comments',
      (await readState()).reviews.annotations.length === 2
      && (await readState()).reviews.annotations.find(item => item.comment.includes('fix this paragraph')).start > before);
    let prefixed = 'Policy header\n\n' + original;
    prefixed = prefixed.replace('Native Markdown review smoke test', 'Native Markdown review policy test')
      .replace('Review this row', 'Updated table row');
    await command({ replace: prefixed });
    await settled('Updated table row');
    await poll(async () => (await readState()).reviews.annotations.length === 2
      && (await readState()).reviews.annotations.every(item => item.status === 'attached'), 'Unchanged reviews did not recover after the native patch');
    check('whole-file edits before and after unchanged annotated blocks retain those comments',
      (await readState()).reviews.annotations.length === 2
      && (await readState()).reviews.annotations.every(item => item.status === 'attached'));
    await command({ replace: prefixed.replace('Second paragraph for selection and inline comments.', 'Second paragraph has been corrected.') });
    await settled('Second paragraph has been corrected.');
    check('an affected comment is removed while an unchanged source block survives',
      (await readState()).reviews.annotations.length === 1 && (await readState()).reviews.annotations[0].comment.includes('unchanged block'));
    check('cleanup preserves the frozen draft and its cleanup policy for unfinished-item reporting',
      (await readState()).reviews.batches.find(item => item.id === batch.id).annotations[0].comment.includes('unfinished requirements')
      && batch.autoDeleteAffected === true);
    await configureReview('autoDeleteAffected', false);
    await addComment('Second paragraph has', 'policy: retain when cleanup is disabled');
    await command({ replace: prefixed.replace('Second paragraph for selection and inline comments.', 'Second paragraph changed again.') });
    await settled('Second paragraph changed again.');
    check('disabling cleanup retains affected comments with changed-source status',
      (await readState()).reviews.annotations.some(item => item.comment.includes('cleanup is disabled') && item.status === 'orphaned'));
    await configureReview('enabled', false);
    await poll(async () => await preview.evaluate(() => document.querySelector('#ccgui-markdown-review').hidden), 'Disabled UI still visible');
    check('feature switch hides the overlay immediately without deleting live reviews', (await readState()).reviews.annotations.length === 2);
    await configureReview('enabled', true);
    await poll(async () => await preview.evaluate(() => !document.querySelector('#ccgui-markdown-review').hidden), 'Enabled UI stayed hidden');
    check('feature can be enabled again in the existing preview', true);
    await configureReview('persist', true);
    await command({ save: true });
    await poll(async () => (await storedReviews()).includes(batch.id), 'Opt-in persistence did not save reviews');
    check('opt-in persistence stores the existing live snapshots', true);
    await configureReview('persist', false);
    await configureReview('enabled', false);
    await command({ save: true });
    await poll(async () => !(await storedReviews()).includes(batch.id), 'Transient policy left content in workspace storage');
    check('disabling persistence removes stored review content and keeps live drafts until close',
      (await readState()).reviews.annotations.length === 2 && (await readState()).reviews.batches.some(item => item.id === batch.id));
    await chat.screenshot({ path: resolve(folder, 'policy-chat-draft.png') });
  } catch (error) { report.errors.push(error.message); console.error(error); process.exitCode = 1; }
  await writeFile(resolve(folder, 'policy-report.json'), JSON.stringify(report, null, 2));
  process.exit(process.exitCode ?? 0);
}

if (process.argv.includes('--prepare-recovery')) {
  await preview.waitForSelector('#ccgui-markdown-review .ccgui-md-controls');
  await preview.getByRole('button', { name: 'Add to CC GUI', exact: true }).click();
  await chat.waitForSelector('.artifact-review-drafts summary');
  await poll(async () => {
    const current = await readState();
    return current.reviews.batches.some(batch => batch.targetId === current.chatTargetId && batch.state === 'received');
  }, 'Current conversation did not receive the review');
  await command({ save: true });
  const current = await readState();
  await poll(async () => {
    const stored = await storedReviews();
    return current.reviews.batches.filter(batch => batch.targetId === current.chatTargetId).every(batch => stored.includes(batch.id));
  }, 'Current conversation review was not saved');
  check('current conversation review is acknowledged and saved in the lossless envelope', true);
  process.exit(0);
}

if (process.argv.includes('--reset-session')) {
  const before = await readState();
  await command({ newChat: true });
  await poll(async () => (await readState()).chatTargetId !== before.chatTargetId,
    'New empty conversation kept the old review target');
  await poll(async () => await chat.locator('.artifact-review-drafts').count() === 0,
    'New conversation retained the old draft');
  check('new empty conversation gets a different persisted review target', true);
  check('old pending review remains saved without entering the new conversation',
    (await readState()).reviews.batches.some(batch => batch.targetId === before.chatTargetId && batch.state === 'received'));
  await command({ save: true });
  await poll(async () => (await readFile(resolve(folder, '.idea/claudeCodeTabState.xml'), 'utf8'))
    .includes((await readState()).chatTargetId), 'New conversation identity was not saved');
  await writeFile(resolve(folder, 'session-reset-report.json'), JSON.stringify(report, null, 2));
  process.exit(0);
}

if (process.argv.includes('--new-session-restart')) {
  await preview.waitForSelector('#ccgui-markdown-review .ccgui-md-controls');
  await chat.waitForSelector('.input-editable');
  const restored = await readState();
  check('restart of a new empty conversation does not recover another conversation draft',
    restored.reviews.batches.some(batch => batch.targetId !== restored.chatTargetId && batch.state === 'received')
    && await chat.locator('.artifact-review-drafts').count() === 0);
  check('changing the conversation leaves document comments available after restart', restored.reviews.annotations.length >= 2);
  check('real IDE XML storage restores emoji in comments and source context',
    restored.reviews.annotations.some(item => item.comment.includes('🧪'))
    && restored.reviews.annotations.some(item => item.prefix.includes('😀')));
  await writeFile(resolve(folder, 'session-restart-report.json'), JSON.stringify(report, null, 2));
  process.exit(0);
}

if (process.argv.includes('--restore-only')) {
  await preview.waitForSelector('#ccgui-markdown-review .ccgui-md-controls');
  await chat.waitForSelector('.artifact-review-drafts summary');
  const restored = await readState();
  const stored = await storedReviews();
  const tabs = await readFile(resolve(folder, '.idea/claudeCodeTabState.xml'), 'utf8');
  check('IDE restart restores saved annotations', restored.reviews.annotations.length >= 2
    && await preview.locator('.ccgui-md-controls').textContent().then(text => text.includes('2 comments')));
  check('IDE restart restores the pending draft to its persisted chat target',
    restored.reviews.batches.some(batch => batch.state === 'received' && tabs.includes(batch.targetId)
      && stored.includes(batch.id)));
  check('chat renders the recovered original review snapshot',
    await chat.locator('.artifact-review-drafts').textContent().then(text => text.includes('请补充验证步骤（已编辑）')));
  await writeFile(resolve(folder, 'restart-report.json'), JSON.stringify(report, null, 2));
  process.exit(0);
}

if (process.argv.includes('--inspect')) {
  console.log(JSON.stringify(await preview.evaluate(() => ({
    meta: document.querySelector('meta[name="markdown-position-attribute-name"]').content,
    root: document.body.firstElementChild.outerHTML.slice(0, 600),
    paragraphs: [...document.querySelectorAll('p')].map(item => item.outerHTML),
    status: document.querySelector('.ccgui-md-controls').textContent,
    geometry: {
      body: [getComputedStyle(document.body).margin, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color],
      overlay: [getComputedStyle(document.querySelector('#ccgui-markdown-review')).margin,
        getComputedStyle(document.querySelector('#ccgui-markdown-review')).transform],
      source: [...document.querySelectorAll('p')].map(element => ({ top: element.getBoundingClientRect().top, left: element.getBoundingClientRect().left })),
      marks: [...document.querySelectorAll('.ccgui-md-highlight')].map(element => ({ top: element.getBoundingClientRect().top,
        left: element.getBoundingClientRect().left, style: element.getAttribute('style') })),
    },
  })), null, 2));
  process.exit(0);
}

try {
  // The legacy recovery scenarios explicitly opt in; production defaults are transient.
  await configureReview('persist', true);
  await configureReview('autoDeleteAffected', false);
  await configureReview('enabled', true);
  await preview.waitForSelector('#ccgui-markdown-review .ccgui-md-controls');
  report.metadata = await preview.evaluate(() => ({
    title: document.title,
    positionAttribute: document.querySelector('meta[name="markdown-position-attribute-name"]').content,
    nativeRoot: document.body.firstElementChild.tagName,
    nativeRootAttributes: [...document.body.firstElementChild.attributes].map(attr => [attr.name, attr.value]),
    overlayCount: document.querySelectorAll('#ccgui-markdown-review').length,
  }));
  await chat.evaluate(() => document.querySelector('.changelog-close-btn')?.click());
  check('native CSP loads annotation JS and CSS', report.metadata.overlayCount === 1
    && await preview.locator('.ccgui-md-controls').evaluate(element => getComputedStyle(element).position) === 'fixed');

  const original = await readFile(resolve(folder, 'review.md'), 'utf8');
  while ((await readState()).reviews.annotations.length) {
    const count = (await readState()).reviews.annotations.length;
    await preview.getByRole('button', { name: count + ' comments' }).click();
    await preview.getByRole('button', { name: 'Delete' }).click();
    await poll(async () => (await readState()).reviews.annotations.length < count, 'Could not clear previous test annotations');
  }
  const before = (await readState()).reviews.annotations.length;
  await selectParagraph(preview, 'Second paragraph');
  await preview.getByRole('button', { name: 'Comment', exact: true }).click();
  await preview.getByRole('textbox').fill('请补充验证步骤 <script>仅作为文字</script>');
  await preview.getByRole('button', { name: 'Add comment', exact: true }).click();
  await poll(async () => (await readState()).reviews.annotations.length === before + 1, 'Native comment was not persisted');
  check('native BrowserPipe saves a comment on the later paragraph', true);
  check('native theme colors and viewport highlight geometry agree', await preview.evaluate(() => {
    const paragraph = [...document.querySelectorAll('p')].find(element => element.textContent.includes('Second paragraph'));
    const range = document.createRange(); range.selectNodeContents(paragraph);
    const expected = range.getClientRects()[0];
    const actual = document.querySelector('.ccgui-md-highlight').getBoundingClientRect();
    return Math.abs(actual.top - expected.top) <= 1 && Math.abs(actual.left - expected.left) <= 1
      && getComputedStyle(document.querySelector('.ccgui-md-controls')).backgroundColor === getComputedStyle(document.body).backgroundColor;
  }));
  await preview.getByRole('button', { name: (before + 1) + ' comments', exact: true }).click();
  check('comment HTML stays plain text', await preview.locator('.ccgui-md-popup').textContent().then(text => text.includes('<script>仅作为文字</script>')));
  await preview.getByRole('button', { name: 'Edit', exact: true }).click();
  await preview.getByRole('textbox').fill('请补充验证步骤（已编辑）');
  await preview.getByRole('button', { name: 'Save', exact: true }).click();
  await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === '请补充验证步骤（已编辑）'), 'Native edit failed');
  check('native revisioned comment editing works', true);
  await preview.getByRole('button', { name: 'Add to CC GUI', exact: true }).click();
  await chat.waitForSelector('.artifact-review-drafts summary');
  await chat.locator('.artifact-review-drafts summary').evaluate(element => element.parentElement.open = true);
  await poll(async () => (await readState()).reviews.batches.some(batch => batch.state === 'received'
    && batch.annotations.some(item => item.comment === '请补充验证步骤（已编辑）')), 'Chat did not acknowledge review');
  check('real CC GUI receives and acknowledges the immutable review draft',
    await chat.locator('.artifact-review-drafts').textContent().then(text => text.includes('请补充验证步骤（已编辑）')));

  await selectParagraph(preview, 'First paragraph', true);
  await preview.getByRole('button', { name: 'Comment', exact: true }).click();
  await preview.getByRole('textbox').fill('跨加粗节点的批注 🧪');
  await preview.getByRole('button', { name: 'Add comment', exact: true }).click();
  await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === '跨加粗节点的批注 🧪'), 'Formatted selection did not pass native renderer validation');
  check('formatted cross-node selection is validated by the IDE renderer', true);

  const commentCount = (await readState()).reviews.annotations.length;
  await selectParagraph(preview, 'Second paragraph');
  await preview.waitForSelector('.ccgui-md-toolbar');
  await preview.getByRole('button', { name: 'Quote to CC GUI', exact: true }).click();
  await poll(async () => (await readState()).reviews.batches.some(batch => batch.kind === 'quote'
    && batch.state === 'received'), 'Native quotation did not reach CC GUI');
  check('native Quote adds source context to CC GUI without creating a comment',
    (await readState()).reviews.annotations.length === commentCount);

  const originalStart = (await readState()).reviews.annotations.find(item => item.comment === '请补充验证步骤（已编辑）').start;
  await command({ prepend: 'Inserted header\n\n' });
  await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === '请补充验证步骤（已编辑）'
    && item.start > originalStart && item.status === 'attached'), 'RangeMarker did not relocate after document edit');
  check('unsaved IDE document edits relocate comments through native repaint', true);
  await poll(async () => (await preview.locator('.ccgui-md-marker').count()) > 0, 'Overlay lost after native repaint');
  check('native IncrementalDOM repaint preserves the overlay', true);
  const frozen = (await readState()).reviews.batches.find(batch => batch.annotations.some(item => item.comment === '请补充验证步骤（已编辑）'));
  check('chat draft retains the original source snapshot after edits', frozen.annotations.find(item => item.comment === '请补充验证步骤（已编辑）').start === originalStart);

  await command({ replace: original.replace('Second paragraph for selection and inline comments.', 'Replacement paragraph.') });
  await poll(async () => (await readState()).reviews.annotations.some(item => item.comment === '请补充验证步骤（已编辑）' && item.status === 'orphaned'), 'Deleted source was not orphaned');
  check('deleted original text stays saved as an orphaned comment', true);
  await command({ replace: original, reopen: true });
  await poll(async () => (await pages()).some(page => page.url().includes('/markdownPreview/')), 'Preview did not reopen');
  const reopened = (await pages()).find(page => page.url().includes('/markdownPreview/'));
  await reopened.waitForSelector('#ccgui-markdown-review .ccgui-md-controls');
  check('closing and reopening creates one overlay and restores saved comments',
    await reopened.locator('#ccgui-markdown-review').count() === 1);
  await reopened.screenshot({ path: resolve(folder, 'native-preview.png') });
  await chat.screenshot({ path: resolve(folder, 'chat-review-draft.png') });
  await command({ save: true });
  const savedState = await readState();
  await poll(async () => {
    try {
      const workspace = await storedReviews();
      return savedState.reviews.annotations.every(item => workspace.includes(item.id));
    }
    catch { return false; }
  }, 'IDE workspace state was not saved');
  const workspace = await readFile(resolve(folder, '.idea/workspace.xml'), 'utf8');
  const tabs = await readFile(resolve(folder, '.idea/claudeCodeTabState.xml'), 'utf8');
  check('IDE workspace storage persists annotations and chat review target identity',
    workspace.includes('CCGuiMarkdownReview') && tabs.includes('reviewTargetId'));
  if (process.argv.includes('--exit')) await command({ exit: true });
} catch (error) {
  report.errors.push(error.message);
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(folder, 'runtime-report.json'), JSON.stringify(report, null, 2));
  // process exit disconnects this CDP client without closing the IDE's browsers.
  setTimeout(() => process.exit(process.exitCode ?? 0), 20);
}
