import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const port = Number(process.env.PLAYWRIGHT_OFFICE_PORT ?? 4197);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  ...base,
  testMatch: ['pet-office.spec.ts', 'pet-office-live.spec.ts', 'pet-office-shared.spec.ts', 'pet-office-refinements.spec.ts'],
  testIgnore: [],
  projects: [...(base.projects ?? []),
    { name: 'chromium-full-hd', use: { browserName: 'chromium', viewport: { width: 1920, height: 1080 } } },
    { name: 'chromium-scaled-desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 } },
  ],
  use: {
    ...base.use, baseURL, channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort --outDir dist/office`,
    url: `${baseURL}/office.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
