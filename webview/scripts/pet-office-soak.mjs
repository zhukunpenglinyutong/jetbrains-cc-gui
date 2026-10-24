import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';

const minutes = Number(process.env.OFFICE_SOAK_MINUTES ?? 30);
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error('Invalid soak duration');
const address = process.env.OFFICE_PREVIEW_URL ?? 'http://127.0.0.1:4197/office.html';
if (new URL(address).hostname !== '127.0.0.1') throw new Error('Soak target must be isolated loopback');
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../../.codex/office-g0');
await mkdir(output, { recursive: true });
const samples = [];
const violations = [];
const started = Date.now();
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const session = await context.newCDPSession(page);
const browserSession = await browser.newBrowserCDPSession();
await session.send('Performance.enable');
const metadata = { browser: browser.version(), os: release(), platform: process.platform, minutes, simulated: true };
let previousCpu = null;

function windowsMemory(ids) {
  if (process.platform !== 'win32') return null;
  const safeIds = ids.filter(id => Number.isSafeInteger(id) && id > 0);
  const script = `$officeIds=@(${safeIds.join(',')}); @(Get-Process -Id $officeIds -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64,WorkingSet64) | ConvertTo-Json -Compress`;
  const result = execFileSync(resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const parsed = JSON.parse(result.trim() || '[]');
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return { privateBytes: rows.reduce((sum, row) => sum + row.PrivateMemorySize64, 0), workingSet: rows.reduce((sum, row) => sum + row.WorkingSet64, 0) };
}

async function sample(stage) {
  const diagnostics = await page.evaluate(() => window.petOfficeDiagnostics?.());
  const heap = await session.send('Runtime.getHeapUsage');
  const processes = (await browserSession.send('SystemInfo.getProcessInfo')).processInfo;
  const cpuTime = processes.reduce((sum, entry) => sum + entry.cpuTime, 0);
  const now = Date.now();
  const cpuPercent = previousCpu ? (cpuTime - previousCpu.cpuTime) * 100000 / (now - previousCpu.time) : null;
  previousCpu = { cpuTime, time: now };
  const memory = windowsMemory(processes.map(entry => entry.id));
  const row = { elapsedMs: now - started, stage, ...diagnostics, heapBytes: heap.usedSize, cpuPercent, ...memory };
  samples.push(row);
  if (Number(row.decodedBytes) > 32 * 1024 * 1024) violations.push('decoded budget');
  await writeFile(resolve(output, 'soak-progress.json'), JSON.stringify({ metadata, samples, violations }, null, 2));
  console.log(JSON.stringify(row));
}

async function chooseCount(count) {
  await page.getByRole('combobox', { name: 'Simulated sessions' }).click();
  await page.locator('.ant-select-item-option-content').filter({ hasText: new RegExp(`^${count}$`) }).click();
  await expect.poll(() => page.evaluate(() => window.petOfficeDiagnostics?.().sourceCount)).toBe(count);
}

try {
  await page.goto(address);
  await expect(page.getByRole('heading', { name: 'Pet Office', exact: true })).toBeVisible();
  for (const count of [0, 10, 50]) {
    await chooseCount(count);
    await page.waitForTimeout(3000);
    await sample(`baseline-${count}`);
    if (count > 0 && samples.at(-1).fps < 20) violations.push(`baseline FPS ${count}`);
  }
  await page.screenshot({ path: resolve(output, 'soak-50.png') });
  let tick = 0;
  while (Date.now() - started < minutes * 60_000) {
    const hidden = Math.floor(tick / 2) % 2 === 0;
    await page.evaluate(value => window.petOfficeSetVisible?.(value), !hidden);
    if (tick % 2 === 0) await page.getByRole('button', { name: 'Robot sheet fixture' }).click();
    else await page.getByRole('button', { name: 'Use built-in Pet' }).click();
    await expect.poll(() => page.evaluate(() => window.petOfficeDiagnostics?.().running)).toBe(!hidden);
    const frames = await page.evaluate(() => window.petOfficeDiagnostics?.().frames);
    await page.waitForTimeout(Math.min(30_000, Math.max(0, minutes * 60_000 - (Date.now() - started))));
    await sample(hidden ? 'host-hidden' : 'visible-switch');
    if (hidden && samples.at(-1).frames !== frames) violations.push('hidden frames advanced');
    if (!hidden && samples.at(-1).fps < 20) violations.push('visible FPS below 20');
    tick++;
  }
  const warm = samples.filter(row => row.elapsedMs >= 120_000);
  const first = warm.slice(0, 4), last = warm.slice(-4);
  const mean = (rows, field) => rows.reduce((sum, row) => sum + Number(row[field] ?? 0), 0) / Math.max(1, rows.length);
  const growth = { heapMiB: (mean(last, 'heapBytes') - mean(first, 'heapBytes')) / 1024 / 1024, privateMiB: (mean(last, 'privateBytes') - mean(first, 'privateBytes')) / 1024 / 1024 };
  if (minutes >= 5 && growth.heapMiB > 16) violations.push('heap growth above 16 MiB');
  if (minutes >= 5 && growth.privateMiB > 32) violations.push('private memory growth above 32 MiB');
  await writeFile(resolve(output, 'soak-result.json'), JSON.stringify({ metadata, samples, growth, violations, passed: violations.length === 0 }, null, 2));
  console.log(JSON.stringify({ complete: true, growth, violations }));
  if (violations.length) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
