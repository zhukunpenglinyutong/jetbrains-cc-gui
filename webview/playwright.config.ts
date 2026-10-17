import { defineConfig, devices } from '@playwright/test';

const localNoProxy = ['127.0.0.1', 'localhost'];
for (const variable of ['NO_PROXY', 'no_proxy']) {
  const existing = process.env[variable]
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];
  process.env[variable] = Array.from(new Set([...existing, ...localNoProxy])).join(',');
}

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${PORT}`;
const viteCommand = `"${process.execPath}" "${process.cwd()}/node_modules/vite/bin/vite.js"`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `${viteCommand} --host 127.0.0.1 --port ${PORT}`,
    cwd: process.cwd(),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'chromium-narrow',
      use: { ...devices['Desktop Chrome'], viewport: { width: 496, height: 884 } },
    },
    {
      name: 'chromium-short',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1018, height: 365 } },
    },
    {
      name: 'chromium-mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 393, height: 851 } },
    },
  ],
});
