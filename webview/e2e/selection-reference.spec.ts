import { expect, test } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

test('long selection filenames keep their line range visible and full tooltip', async ({ page }) => {
  await page.addInitScript((version) => {
    localStorage.setItem('lastSeenChangelogVersion', version);
    window.sendToJava = () => {};
  }, APP_VERSION);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => typeof window.insertCodeSnippetAtCursor)).toBe('function');
  const reference = 'C:/workspace/src/service/impl/PhysicalTestDataServiceImpl.java#L73-76';
  await page.evaluate((value) => window.insertCodeSnippetAtCursor?.(`@${value}`), reference);
  const tag = page.locator('.file-tag').first();
  const filename = tag.locator('.file-tag-text');
  const lines = tag.locator('.file-tag-lines');
  await expect(filename).toHaveText('PhysicalTestDataServiceImpl.java');
  await expect(lines).toHaveText('#L73-76');
  await expect(tag).toHaveAttribute('data-file-path', reference);
  await expect(tag).toHaveAttribute('data-tooltip', reference);
  // Exercise ellipsis even when this font fits the filename within 200px.
  await filename.evaluate((el) => { (el as HTMLElement).style.maxWidth = '120px'; });
  expect(await filename.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await lines.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await lines.hover();
  await expect(page.locator('.tooltip-popup')).toContainText(reference);
});
