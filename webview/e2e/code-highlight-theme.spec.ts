import { expect, test, type Locator, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

const assistantText = [
  '```kotlin',
  'class Counter(private var count: Int) {',
  '    override fun toString(): String = "$count" // count',
  '}',
  '```',
].join('\n');
const tokenClasses = ['hljs-keyword', 'hljs-string', 'hljs-title', 'hljs-comment'];
const githubDarkString = 'rgb(165, 214, 255)';
const githubDarkKeyword = 'rgb(255, 123, 114)';
const githubLightString = 'rgb(3, 47, 98)';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((appVersion) => {
    localStorage.setItem('lastSeenChangelogVersion', appVersion);
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      claudePermissionMode: 'bypassPermissions',
    }));
    window.sendToJava = (message) => {
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => window.updateDependencyStatus?.(JSON.stringify({
          'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
          'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
        })), 0);
      }
    };
  }, APP_VERSION);
  await page.goto('/');
  await expect(page.locator('.input-editable')).toBeVisible();
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.evaluate((assistant) => {
    window.setSessionId?.('code-highlight-theme-session');
    window.updateMessages?.(JSON.stringify([
      { type: 'assistant', content: assistant,
        raw: { uuid: 'highlight-assistant', message: { content: [{ type: 'text', text: assistant }] } } },
    ]));
  }, assistantText);
  await expect(assistantCode(page).locator('.hljs-keyword').first()).toBeVisible();
});

function assistantCode(page: Page) {
  return page.locator('.message.assistant .code-block-wrapper pre code');
}

async function setTheme(page: Page, theme: string) {
  await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
}

function tokenColor(code: Locator, tokenClass: string) {
  return code.locator(`.${tokenClass}`).first().evaluate(node => getComputedStyle(node).color);
}

function luminance(color: string) {
  const [r, g, b] = (color.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map(channel => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('light theme code tokens meet WCAG AA contrast on the code block background', async ({ page }) => {
  await setTheme(page, 'light');
  const code = assistantCode(page);
  const background = await code.evaluate(node => getComputedStyle(node.closest('pre')!).backgroundColor);
  expect(background).toBe('rgb(245, 245, 245)');
  for (const tokenClass of tokenClasses) {
    await expect(code.locator(`.${tokenClass}`), tokenClass).not.toHaveCount(0);
    const color = await tokenColor(code, tokenClass);
    expect(contrast(color, background), `${tokenClass} ${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
});

test('dark theme keeps the github-dark palette', async ({ page }) => {
  await setTheme(page, 'dark');
  const code = assistantCode(page);
  await expect(code.locator('.hljs-string')).not.toHaveCount(0);
  await expect(code.locator('.hljs-keyword')).not.toHaveCount(0);
  expect(await tokenColor(code, 'hljs-string')).toBe(githubDarkString);
  expect(await tokenColor(code, 'hljs-keyword')).toBe(githubDarkKeyword);
});

test('switching data-theme at runtime restyles code without a reload', async ({ page }) => {
  const code = assistantCode(page);
  await expect(code.locator('.hljs-string')).not.toHaveCount(0);
  await setTheme(page, 'light');
  expect(await tokenColor(code, 'hljs-string')).toBe(githubLightString);
  await setTheme(page, 'dark');
  expect(await tokenColor(code, 'hljs-string')).toBe(githubDarkString);
});
