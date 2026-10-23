import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

test('Behavior persists repository-name session matching across reloads', async ({ context, page }, testInfo) => {
  const resources = path.resolve(process.cwd(), '../src/main/resources');
  const html = await readFile(path.join(resources, 'html/claude-chat.html'), 'utf8');
  await context.route('https://cc-gui-webview.local/assets/**', async (route) => {
    const fileName = path.posix.basename(new URL(route.request().url()).pathname);
    const compressed = fileName.endsWith('.js') || fileName.endsWith('.css');
    const stored = await readFile(path.join(resources, 'webview/assets', compressed ? `${fileName}.gz` : fileName));
    await route.fulfill({
      body: compressed ? gunzipSync(stored) : stored,
      contentType: fileName.endsWith('.js') ? 'text/javascript' : fileName.endsWith('.css') ? 'text/css' : 'application/octet-stream',
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });
  await context.route('**/repository-setting', (route) => route.fulfill({ body: html, contentType: 'text/html' }));
  await context.addInitScript((version) => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    localStorage.setItem('language', 'en');
    window.sendToJava = (message) => {
      if (message.startsWith('set_session_git_repository_matching_enabled:')) {
        const value = JSON.parse(message.slice(message.indexOf(':') + 1));
        localStorage.setItem('fixture-repository-matching', JSON.stringify(value.sessionGitRepositoryMatchingEnabled));
      }
      if (message.startsWith('get_session_git_repository_matching_enabled:')
          || message.startsWith('set_session_git_repository_matching_enabled:')) {
        setTimeout(() => window.updateSessionGitRepositoryMatchingEnabled?.(JSON.stringify({
          sessionGitRepositoryMatchingEnabled: localStorage.getItem('fixture-repository-matching') === 'true',
        })), 0);
      }
      if (message.startsWith('get_dependency_status:')) {
        setTimeout(() => {
          const callback = (window as unknown as Record<string, unknown>).updateDependencyStatus;
          if (typeof callback === 'function') callback(JSON.stringify({
            'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
            'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
          }));
        }, 0);
      }
    };
  }, APP_VERSION);

  const openBehavior = async () => {
    await expect(page.locator('.input-editable')).toBeVisible();
    await page.locator('.header button:has(.codicon-settings-gear)').click();
    await page.getByRole('button', { name: /Behavior$/ }).click();
  };
  const section = page.locator('[class*="streamingSection"]')
    .filter({ hasText: 'Match sessions by Git repository name' });
  const toggle = section.locator('input[type="checkbox"]');
  await page.goto('/repository-setting');
  await openBehavior();
  await expect(toggle).not.toBeChecked();
  await section.locator('label').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('fixture-repository-matching'))).toBe('true');
  await page.reload();
  await openBehavior();
  await expect(toggle).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('repository-history-behavior.png') });
  await section.locator('label').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('fixture-repository-matching'))).toBe('false');
});
