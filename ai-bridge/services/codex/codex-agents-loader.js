/**
 * Legacy Codex session file locator.
 *
 * Normal app-server turns let the native runtime discover AGENTS.md and
 * project fallback instructions. This module remains only for read-only
 * legacy history replay.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getRealHomeDir } from '../../utils/path-utils.js';
import { SESSION_PATCH_SCAN_MAX_FILES } from './codex-utils.js';

/**
 * Finds a session file containing the threadId under ~/.codex/sessions.
 */
export function findSessionFileByThreadId(threadId) {
  if (!threadId || typeof threadId !== 'string') {
    return null;
  }

  const sessionsRoot = join(getRealHomeDir(), '.codex', 'sessions');
  if (!existsSync(sessionsRoot)) {
    return null;
  }

  const stack = [sessionsRoot];
  let visited = 0;

  while (stack.length > 0 && visited < SESSION_PATCH_SCAN_MAX_FILES) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;

    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) {
        return fullPath;
      }
    }
  }

  return null;
}
