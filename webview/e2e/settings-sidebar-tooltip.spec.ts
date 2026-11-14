import { expect, test, type Page } from '@playwright/test';
import { APP_VERSION } from '../src/version/version';

test.setTimeout(60_000);

const WCAG_AA_TEXT_CONTRAST = 4.5;

function relativeLuminance(cssColor: string): number {
  const channels = cssColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  const [r, g, b] = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(first: string, second: string): number {
  const [darker, lighter] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => a - b);
  return (lighter + 0.05) / (darker + 0.05);
}

async function openCollapsedSettings(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript(({ appVersion, theme }) => {
    localStorage.setItem('lastSeenChangelogVersion', appVersion);
    localStorage.setItem('language', 'en');
    localStorage.setItem('theme', theme);
    (window as unknown as { sendToJava: (message: string) => void }).sendToJava = () => {};
  }, { appVersion: APP_VERSION, theme });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

for (const theme of ['light', 'dark'] as const) {
  test(`collapsed sidebar tooltip text is readable in the ${theme} theme`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop', 'Runs at one fixed collapsed viewport');
    // Narrower than AUTO_COLLAPSE_THRESHOLD, so the sidebar only shows icons.
    await page.setViewportSize({ width: 640, height: 720 });
    await openCollapsedSettings(page, theme);

    await page.getByRole('button', { name: 'Provider Management', exact: true }).hover();

    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toHaveText('Provider Management');

    const colors = await tooltip.evaluate((element) => {
      const style = getComputedStyle(element);
      return { text: style.color, background: style.backgroundColor };
    });
    expect(contrastRatio(colors.text, colors.background)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
  });
}
