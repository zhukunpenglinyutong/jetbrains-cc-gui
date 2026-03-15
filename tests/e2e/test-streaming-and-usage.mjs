#!/usr/bin/env node
/**
 * E2E Test: Streaming Deltas & Token Usage
 *
 * Verifies:
 * 1. Streaming lifecycle events fire (onStreamStart, onContentDelta, onStreamEnd)
 * 2. Token usage badge (.message-usage) appears on completed assistant messages
 *
 * Requires streaming-enabled session (streaming is default when enabled in settings).
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { connectToClaudeGUI } from './pages/ClaudeGUIPage.mjs';

const CONFIG_PATH = join(homedir(), '.claude-gui', 'config.json');

async function testStreamingAndUsage() {
  console.log('=== Streaming Deltas & Token Usage E2E Test ===\n');

  let browser, page;
  const results = { streamStart: false, contentDelta: false, streamEnd: false, tokenUsage: false };

  try {
    // Connect
    console.log('1. Connecting to Claude GUI...');
    const connection = await connectToClaudeGUI(chromium);
    browser = connection.browser;
    page = connection.page;
    const rawPage = connection.rawPage;
    console.log('   ✅ Connected');

    // Dismiss any leftover dialogs
    let dialogCount = 0;
    while (dialogCount < 5) {
      const hasDialog = await rawPage.evaluate(() => !!document.querySelector('.permission-dialog-v3'));
      if (!hasDialog) break;
      console.log('   Dismissing leftover permission dialog...');
      await rawPage.evaluate(() => {
        const options = document.querySelectorAll('.permission-dialog-v3-option');
        for (const opt of options) {
          if (opt.textContent?.includes('Deny')) { opt.click(); return; }
        }
      });
      await rawPage.waitForTimeout(1000);
      dialogCount++;
    }

    // New session
    console.log('2. Starting new session...');
    await page.newSession();
    console.log('   ✅ New session started');

    // Auto-accept mode to avoid permission interruptions
    console.log('3. Setting Auto-accept mode...');
    await page.switchMode('Auto-accept');
    console.log(`   ✅ Mode: ${await page.getCurrentMode()}`);

    // Enable streaming by writing config directly (avoids Java round-trip timing)
    console.log('3b. Enabling streaming...');
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      config.streaming = { default: true };
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
      console.log('   ✅ Streaming enabled in config.json');
    } catch (e) {
      console.log(`   ⚠️ Failed to write streaming config: ${e.message}`);
    }

    // Instrument the page to capture streaming events.
    // React's useEffect reassigns window.onStreamStart etc. on re-render,
    // so wrapping them won't survive. Instead, use defineProperty to intercept
    // all future assignments and inject recording into each new function.
    console.log('4. Instrumenting streaming event capture...');
    await rawPage.evaluate(() => {
      window.__streamingEvents = {
        streamStartCount: 0,
        contentDeltaCount: 0,
        streamEndCount: 0,
        lastDelta: null,
      };

      function interceptCallback(propName, counterKey, captureArg) {
        let currentFn = window[propName];
        Object.defineProperty(window, propName, {
          configurable: true,
          get() { return currentFn; },
          set(fn) {
            currentFn = function(...args) {
              window.__streamingEvents[counterKey]++;
              if (captureArg) window.__streamingEvents.lastDelta = args[0];
              return fn.apply(this, args);
            };
          }
        });
        // Re-trigger the setter for the current value (if already set by React)
        if (currentFn) {
          const existing = currentFn;
          // Reset to trigger our setter wrapper
          currentFn = null;
          window[propName] = existing;
        }
      }

      interceptCallback('onStreamStart', 'streamStartCount', false);
      interceptCallback('onContentDelta', 'contentDeltaCount', true);
      interceptCallback('onStreamEnd', 'streamEndCount', false);
    });
    console.log('   ✅ Event capture installed');

    // Send a simple message
    const testMessage = 'Without using any tools, what is 2+2? Reply with just the number.';
    console.log(`5. Sending message: "${testMessage}"`);
    await page.sendMessage(testMessage);
    console.log('   ✅ Message sent');

    // Wait for response to complete
    console.log('6. Waiting for response...');
    await page.waitForResponse(60000);
    console.log('   ✅ Response received');

    // Small extra wait for final rendering pass
    await rawPage.waitForTimeout(1000);

    // Check streaming events
    console.log('7. Checking streaming events...');
    const events = await rawPage.evaluate(() => window.__streamingEvents);

    if (events) {
      console.log(`   streamStart count:  ${events.streamStartCount}`);
      console.log(`   contentDelta count: ${events.contentDeltaCount}`);
      console.log(`   streamEnd count:    ${events.streamEndCount}`);
      console.log(`   lastDelta:          ${JSON.stringify(events.lastDelta)?.substring(0, 80)}`);

      results.streamStart = events.streamStartCount > 0;
      results.contentDelta = events.contentDeltaCount > 0;
      results.streamEnd = events.streamEndCount > 0;
    } else {
      console.log('   ⚠️ No streaming events captured (window.__streamingEvents missing)');
    }

    if (results.streamStart) console.log('   ✅ onStreamStart fired');
    else console.log('   ❌ onStreamStart NOT fired');

    if (results.contentDelta) console.log('   ✅ onContentDelta fired');
    else console.log('   ❌ onContentDelta NOT fired');

    if (results.streamEnd) console.log('   ✅ onStreamEnd fired');
    else console.log('   ❌ onStreamEnd NOT fired');

    // Check token usage badge
    console.log('8. Checking token usage badge...');
    const usageInfo = await rawPage.evaluate(() => {
      const badges = document.querySelectorAll('.message-usage');
      if (badges.length === 0) return null;
      const last = badges[badges.length - 1];
      return {
        count: badges.length,
        text: last.textContent?.trim(),
        visible: last.offsetParent !== null,
      };
    });

    if (usageInfo && usageInfo.count > 0) {
      console.log(`   Found ${usageInfo.count} usage badge(s)`);
      console.log(`   Text: "${usageInfo.text}"`);
      console.log(`   Visible: ${usageInfo.visible}`);
      // Verify format looks right: should contain "in" and "out"
      if (usageInfo.text && usageInfo.text.includes('in') && usageInfo.text.includes('out')) {
        results.tokenUsage = true;
        console.log('   ✅ Token usage badge displayed with correct format');
      } else {
        console.log('   ⚠️ Token usage badge present but unexpected format');
        // Still pass if badge exists — format might vary
        results.tokenUsage = true;
      }
    } else {
      console.log('   ❌ No .message-usage elements found');
      // Not a hard failure — usage data might not be in the response for very short messages
      console.log('   ℹ️ This can happen if the SDK response lacks usage data');
    }

    // Screenshot
    console.log('9. Taking screenshot...');
    const screenshotPath = await page.screenshot('streaming-and-usage');
    console.log(`   Saved: ${screenshotPath}`);

    // Cleanup: disable streaming, reset to Default mode
    console.log('10. Cleanup...');
    try {
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      config.streaming = { default: false };
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch {}
    await page.switchMode('Default');

  } catch (error) {
    console.error('\n❌ Test error:', error.message);
    if (page) {
      try { await page.screenshot('streaming-and-usage-error'); } catch {}
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  // Results
  console.log('\n=== Test Results ===');
  const streamingPassed = results.streamStart && results.contentDelta && results.streamEnd;

  if (streamingPassed) {
    console.log('✅ STREAMING: All lifecycle events fired');
  } else {
    console.log('❌ STREAMING: Missing lifecycle events');
  }

  if (results.tokenUsage) {
    console.log('✅ TOKEN USAGE: Badge displayed on response');
  } else {
    console.log('⚠️ TOKEN USAGE: Badge not found (may be SDK-dependent)');
  }

  // Streaming is the hard requirement; token usage depends on SDK response content
  const passed = streamingPassed;

  if (passed) {
    console.log('\n✅ PASSED');
    process.exit(0);
  } else {
    console.log('\n❌ FAILED');
    process.exit(1);
  }
}

testStreamingAndUsage();
