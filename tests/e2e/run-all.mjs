#!/usr/bin/env node
/**
 * E2E Test Runner
 *
 * Runs all validated E2E tests and reports results.
 *
 * Usage: node tests/e2e/run-all.mjs
 */

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { rmSync, mkdirSync, existsSync, readdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, 'screenshots');

/**
 * Clean up test artifacts (screenshots) from previous runs
 */
function cleanupArtifacts() {
  if (existsSync(SCREENSHOTS_DIR)) {
    const files = readdirSync(SCREENSHOTS_DIR);
    if (files.length > 0) {
      console.log(`Cleaning up ${files.length} artifact(s) from previous run...`);
      rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
    }
  }
  // Recreate empty directory for this run
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

// List of validated tests to run (in order)
const TESTS = [
  'test-message-flow.mjs',        // US-1: Core message flow
  'test-session-management.mjs',  // US-2: Session management
  'test-session-resume.mjs',      // US-3: Resume existing session
  'test-model-selection.mjs',     // US-4: Model selection
  'test-mode-switching.mjs',      // US-6: Mode switching
  'test-permission-flow.mjs',     // US-5: Permission dialogs
  'test-plan-approval.mjs',       // US-7: Plan mode
  'test-error-handling.mjs',      // US-14: Error handling
  'test-favorites.mjs',           // US-11: Favorites
  'test-session-titles.mjs',      // US-12: Session titles
  'test-settings.mjs',            // US-13: Settings
  'test-mcp-settings.mjs',        // US-9: MCP servers
  'test-skills.mjs',              // US-10: Skills/Agents
  'test-auth-states.mjs',         // Auth state detection
  'test-auth-warning-bar.mjs',    // Auth warning bar (CDP-injected)
  'test-auth-validation.mjs',     // Auth validation with API calls
  'test-image-attachment.mjs',    // Image attachment flow
  'test-streaming-and-usage.mjs', // Streaming deltas + token usage
];

async function runTest(testFile) {
  return new Promise((resolve) => {
    const testPath = join(__dirname, testFile);
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running: ${testFile}`);
    console.log('='.repeat(60));

    const proc = spawn('node', [testPath], {
      stdio: 'inherit',
      cwd: dirname(__dirname),
    });

    proc.on('close', (code) => {
      resolve({ test: testFile, passed: code === 0 });
    });

    proc.on('error', (err) => {
      console.error(`Error running ${testFile}:`, err.message);
      resolve({ test: testFile, passed: false });
    });
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Claude GUI E2E Test Suite                        ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  // Clean up artifacts from previous runs
  cleanupArtifacts();

  console.log('Prerequisites:');
  console.log('  - Rider running with Claude GUI panel open');
  console.log('  - CDP port 9222 accessible');
  console.log('');

  // Quick CDP check and auto-open Claude GUI if needed
  const openGuiScript = join(__dirname, '../../scripts/open-claude-gui.sh');
  let cdpReady = false;

  try {
    const response = await fetch('http://localhost:9222/json/version');
    if (!response.ok) throw new Error('CDP not responding');
    cdpReady = true;
  } catch (e) {
    console.log('CDP not available, attempting to open Claude GUI panel...');
    try {
      execSync(openGuiScript, { stdio: 'inherit' });
      cdpReady = true;
    } catch (scriptErr) {
      console.error('❌ Failed to open Claude GUI panel automatically');
      console.error('   Please open it manually in Rider.');
      process.exit(1);
    }
  }

  // Verify Claude webview is available (not just CDP)
  if (cdpReady) {
    try {
      const listResponse = await fetch('http://localhost:9222/json/list');
      const targets = await listResponse.json();
      const hasClaudeWebview = targets.some(t => t.title?.includes('Claude'));

      if (!hasClaudeWebview) {
        console.log('Claude webview not found, attempting to open Claude GUI panel...');
        try {
          execSync(openGuiScript, { stdio: 'inherit' });
        } catch (scriptErr) {
          console.error('❌ Failed to open Claude GUI panel automatically');
          process.exit(1);
        }
      }
    } catch (e) {
      // Continue anyway, individual tests will report issues
    }
  }

  console.log('✅ CDP connection verified\n');

  const results = [];
  for (const test of TESTS) {
    const result = await runTest(test);
    results.push(result);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('                    TEST RESULTS');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    console.log(`  ${icon} ${r.test}`);
  }

  console.log('');
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}/${results.length}`);
  console.log('='.repeat(60));

  // Clean up screenshots after successful run
  // Keep them on failure for debugging
  if (failed === 0 && existsSync(SCREENSHOTS_DIR)) {
    const files = readdirSync(SCREENSHOTS_DIR);
    if (files.length > 0) {
      rmSync(SCREENSHOTS_DIR, { recursive: true, force: true });
      console.log(`\nCleaned up ${files.length} screenshot(s)`);
    }
  } else if (failed > 0) {
    console.log(`\nScreenshots preserved in: ${SCREENSHOTS_DIR}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Runner error:', e);
  process.exit(1);
});
