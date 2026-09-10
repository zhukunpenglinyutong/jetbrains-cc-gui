/**
 * ZCode session history over the app-server RPC surface.
 *
 * Sessions are owned by the ZCode CLI's own store; listing and message
 * readback go through a short-lived app-server child (session/list +
 * session/messages). The server matches workspace directories with an exact
 * string compare, so both native and forward-slash path forms are queried
 * and merged (sessions recorded under one form are invisible to the other).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ZcodeAppServerClient } from './zcode-appserver-client.js';
import { resolveZcodeCliPath, resolveZcodeHome, buildZcodeEnv } from './zcode-config.js';

const LIST_LIMIT = 500;

function toForwardSlashes(p) {
  return p.replace(/\\/g, '/');
}

function workspaceVariants(cwd) {
  const native = cwd;
  const forward = toForwardSlashes(cwd);
  const variants = [{ workspacePath: native, workspaceKey: native }];
  if (forward !== native) {
    variants.push({ workspacePath: forward, workspaceKey: forward });
  }
  return variants;
}

function openClient(cwd) {
  const cliPath = resolveZcodeCliPath();
  if (!cliPath) {
    throw new Error('ZCode CLI not found. Install the ZCode desktop client, or set ZCODE_CLI_PATH.');
  }
  const client = new ZcodeAppServerClient({
    nodePath: process.execPath,
    cliPath,
    cwd,
    env: buildZcodeEnv(),
    onReverseRequest: async (method) => {
      if (method === 'session/requestRuntimePreferences') {
        return {
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
          askUserQuestionAutoResolutionEnabled: false,
        };
      }
      const err = new Error(`unsupported reverse request: ${method}`);
      err.code = -32601;
      throw err;
    },
  });
  client.on('stderrLine', (line) => console.error(`[ZCODE-SERVER] ${line}`));
  client.start();
  return client;
}

function toEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Tolerate seconds-based timestamps.
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function isSubagentSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('sess_subagent_');
}

/**
 * List sessions for a workspace, shaped like the other providers' history
 * JSON: {success, sessions:[...], sessionCount, total, provider}.
 */
export async function listSessions(cwd) {
  const client = openClient(cwd);
  try {
    const byId = new Map();
    for (const workspace of workspaceVariants(cwd)) {
      let result;
      try {
        result = await client.request('session/list', {
          workspace,
          includeArchived: false,
          limit: LIST_LIMIT,
        });
      } catch (err) {
        console.error(`[ZCODE] session/list failed for ${workspace.workspacePath}: ${err.message}`);
        continue;
      }
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      for (const s of sessions) {
        if (!s || !s.sessionId || isSubagentSession(s.sessionId)) continue;
        byId.set(s.sessionId, s);
      }
    }

    const sessions = [...byId.values()]
      .map((s) => ({
        sessionId: s.sessionId,
        title: s.title || 'Untitled session',
        messageCount: Number(s.messageCount) || 0,
        lastTimestamp: toEpochMs(s.updatedAt || s.createdAt),
        firstTimestamp: toEpochMs(s.createdAt),
        cwd,
        fileSize: 0,
        provider: 'zcode',
      }))
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

    return {
      success: true,
      sessions,
      sessionCount: sessions.length,
      total: sessions.reduce((sum, s) => sum + s.messageCount, 0),
      provider: 'zcode',
    };
  } finally {
    client.close();
  }
}

/**
 * Read one session's messages as Claude-shaped objects compatible with the
 * webview transcript renderer ({type, message:{role, content:[...]}}).
 */
export async function getSessionMessages(sessionId, cwd) {
  const client = openClient(cwd);
  try {
    await client.request('session/resume', {
      sessionId,
      workspace: { workspacePath: cwd, workspaceKey: cwd },
    });
    const result = await client.request('session/messages', { sessionId });
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return messages.map((m) => mapMessage(m)).filter(Boolean);
  } finally {
    client.close();
  }
}

function mapMessage(m) {
  const info = m?.info && typeof m.info === 'object' ? m.info : {};
  const role = info.role === 'user' ? 'user' : 'assistant';
  const parts = Array.isArray(m?.parts) ? m.parts : [];
  const blocks = [];
  for (const part of parts) {
    const block = mapPart(part, role);
    if (block) blocks.push(block);
  }
  if (blocks.length === 0) return null;
  const type = blocks.some((b) => b.type === 'tool_result') ? 'user' : role;
  return {
    type,
    uuid: info.id || undefined,
    timestamp: toEpochMs(info?.time?.created) || undefined,
    message: { role, content: blocks },
  };
}

function mapPart(part, role) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'reasoning' && typeof part.text === 'string' && part.text) {
    return { type: 'thinking', thinking: part.text };
  }
  if (part.type === 'tool') {
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    if (role === 'assistant') {
      return {
        type: 'tool_use',
        id: part.callID || '',
        name: part.tool || 'tool',
        input: state.input && typeof state.input === 'object' ? state.input : {},
      };
    }
    return {
      type: 'tool_result',
      tool_use_id: part.callID || '',
      is_error: state.status === 'error',
      content: typeof state.output === 'string'
        ? state.output
        : (state.error ? String(state.error) : JSON.stringify(state.output ?? '')),
    };
  }
  return null;
}

/** Tables carrying per-session rows, keyed by their session_id column. */
const SESSION_SCOPED_TABLES = [
  'part',
  'message',
  'todo',
  'session_entry',
  'session_input',
  'session_target',
  'model_usage',
  'turn_usage',
  'tool_usage',
];

/**
 * Delete a session from the ZCode CLI store (~/.zcode/cli/db/db.sqlite).
 *
 * Neither the legacy session/* surface nor v4/command deleteSession actually
 * removes the session row that session/list reads, so deletion is done at the
 * database level: the session row plus every session-scoped dependent row, in
 * one transaction. Subagent sessions linked via session_task_link and direct
 * parent_id children are removed with the root.
 *
 * Requires node >= 22 (node:sqlite). Plugin-created sessions never enter the
 * desktop client's task index, so no client-side index cleanup is needed.
 */
export async function deleteSession(sessionId) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { success: false, error: 'Deleting ZCode sessions requires Node.js 22 or newer.' };
  }

  const dbPath = join(resolveZcodeHome(), 'cli', 'db', 'db.sqlite');
  if (!existsSync(dbPath)) {
    return { success: false, error: 'ZCode session database not found.' };
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000');

    // Session family: the target plus linked subagent children and direct
    // parent_id descendants (one level each way; subagent sessions have no
    // further children in practice).
    const family = new Set([sessionId]);
    for (const row of db.prepare(
      'SELECT child_session_id AS id FROM session_task_link WHERE parent_session_id = ?',
    ).all(sessionId)) {
      if (row.id) family.add(row.id);
    }
    for (const row of db.prepare('SELECT id FROM session WHERE parent_id = ?').all(sessionId)) {
      if (row.id) family.add(row.id);
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      let removed = 0;
      for (const sid of family) {
        for (const table of SESSION_SCOPED_TABLES) {
          db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sid);
        }
        db.prepare(
          'DELETE FROM session_task_link WHERE child_session_id = ? OR parent_session_id = ?',
        ).run(sid, sid);
        removed += db.prepare('DELETE FROM session WHERE id = ?').run(sid).changes;
      }
      db.exec('COMMIT');
      return removed > 0
        ? { success: true }
        : { success: false, error: 'Session not found.' };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  } finally {
    db.close();
  }
}
