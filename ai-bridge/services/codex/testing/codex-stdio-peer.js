/**
 * Controllable stdio test peer emulating the Codex app-server wire protocol.
 *
 * Used by protocol, service, and Java integration tests instead of the real
 * CLI so fixtures never touch a real account. Run standalone:
 *
 *   node codex-stdio-peer.js --scenario <name> [--trace <file>] [--quiet]
 *
 * Wire contract (matches the generated types under
 * docs/codex/app-server-protocol/generated):
 *  - client requests:      {id, method, params}          (no `jsonrpc` field)
 *  - responses:            {id, result} or {id, error}
 *  - notifications:        {method, params}
 *  - server requests:      {id, method, params}          (numeric or string id)
 *  - one NDJSON object per line on stdout; stderr is free-form logging.
 *
 * The peer answers `initialize`/`initialized`, then hands every other method
 * to the selected scenario. Scenarios drive the wire with the ctx helpers so
 * tests can stage notifications before responses, reverse requests, duplicate
 * terminal events, abrupt disconnects, and stderr floods.
 */

import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PEER_PROTOCOL_VERSION = 1;

export const THREAD_ID = 'th-test-root-0001';
export const CHILD_THREAD_ID = 'th-test-child-0002';
export const TURN_ID = 'turn-test-0001';

/** Persisted native history with the same visible item types emitted by streaming. */
export function makeNativeHistoryTurn(turnId = 'history-turn') {
  return { id: turnId, status: 'completed', itemsView: 'full', startedAt: 1, items: [
    { id: `${turnId}:user`, type: 'userMessage', clientId: `${turnId}:client`, content: [{ type: 'text', text: 'inspect' }] },
    { id: `${turnId}:reasoning`, type: 'reasoning', summary: ['Check the history projection'], content: [] },
    { id: `${turnId}:command`, type: 'commandExecution', command: 'git status', cwd: '/tmp/codex-peer', status: 'completed', aggregatedOutput: 'clean', exitCode: 0 },
    { id: `${turnId}:agent`, type: 'agentMessage', text: 'History complete' },
  ] };
}

export function makeThreadStartResponse(params = {}) {
  const sandbox = params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' }
    : params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return {
    thread: {
      id: params.threadId || THREAD_ID,
      forkedFrom: null,
      parentThreadId: params.threadId === CHILD_THREAD_ID ? THREAD_ID : null,
      name: null,
      createdAt: 0,
      updatedAt: 0,
      source: 'exec',
      provider: null,
      model: params.model || 'test-model',
      modelProvider: 'openai',
      serviceTier: null,
      cwd: params.cwd || '/tmp/codex-peer',
      approvalPolicy: params.approvalPolicy || 'on-request',
      sandbox,
      reasoningEffort: 'medium',
      personality: null,
      ephemeral: false,
      status: { type: 'idle' },
      error: null,
    },
    model: params.model || 'test-model',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: params.cwd || '/tmp/codex-peer',
    approvalPolicy: params.approvalPolicy || 'on-request',
    sandbox,
    reasoningEffort: 'medium',
  };
}

/**
 * Trace recorder shared with Java/React fixtures (see docs/codex/app-server.md).
 * Version 1 lines: {traceVersion, event}. No secrets: only ids, methods,
 * directions, byte counts, and terminal counters are recorded.
 */
export class PeerTrace {
  constructor(filePath) {
    this.filePath = filePath || null;
    this.events = [];
    this.startedAt = Date.now();
    if (this.filePath) {
      try {
        writeFileSync(this.filePath, `{"traceVersion":${PEER_PROTOCOL_VERSION}}\n`, 'utf8');
      } catch { /* caller surface failures via events() */ }
    }
  }

  record(kind, data = {}) {
    const event = {
      traceVersion: PEER_PROTOCOL_VERSION,
      t: Date.now() - this.startedAt,
      kind,
      ...data,
    };
    this.events.push(event);
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, JSON.stringify(event) + '\n', 'utf8');
      } catch { /* non-fatal for the peer */ }
    }
    return event;
  }
}

function turnCompleted(turnId, status = 'completed') {
  return {
    method: 'turn/completed',
    params: {
      threadId: THREAD_ID,
      turn: { id: turnId, status, error: null },
      usage: null,
    },
  };
}

function normalizedServiceTier(tier) {
  return tier === 'fast' ? 'priority' : tier === null ? 'default' : tier;
}

export const SCENARIOS = {
  'credential-env': {
    async onTurnStart(params, ctx) {
      const configured = Boolean(process.env.CODEMOSS_TEST_NATIVE_KEY);
      if (params.input?.[0]?.text === 'native credential request' && !configured) {
        ctx.replyError(ctx.currentId, { code: -32600, message: 'Missing credential environment CODEMOSS_TEST_NATIVE_KEY' });
        return;
      }
      if (params.input?.[0]?.text === 'native credential failure') {
        ctx.replyError(ctx.currentId, { code: -32600, message: `Fixture rejected credential ${process.env.CODEMOSS_TEST_NATIVE_KEY}` });
        return;
      }
      const turnId = `credential-turn-${ctx.currentId}`;
      ctx.reply(ctx.currentId, { turn: { id: turnId } });
      ctx.notify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: turnId, status: 'inProgress' } } });
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId,
        item: { id: 'credential-status', type: 'agentMessage', text: JSON.stringify({ configured }) } } });
      ctx.notify(turnCompleted(turnId));
    },
  },
  'delayed-compact-start': {
    async onCompactStart(_params, ctx) {
      const turnId = `prepared-compact-${ctx.currentId}`;
      ctx.reply(ctx.currentId, {});
      // Remote compaction captures step context before announcing its native turn.
      await ctx.sleep(160);
      if (ctx.finished) return;
      ctx.notify({ method: 'turn/started', params: { threadId: THREAD_ID,
        turn: { id: turnId, status: 'inProgress' } } });
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId,
        item: { id: 'prepared-compaction', type: 'contextCompaction' } } });
      ctx.notify(turnCompleted(turnId));
    },
  },
  'service-tier': {
    async onTurnStart(params, ctx) {
      if (Object.hasOwn(params, 'serviceTier')) ctx.nativeTier = normalizedServiceTier(params.serviceTier);
      const turnId = `tier-turn-${ctx.currentId}`;
      ctx.reply(ctx.currentId, { turn: { id: turnId } });
      ctx.notify({ method: 'turn/started', params: { threadId: THREAD_ID,
        turn: { id: turnId, status: 'inProgress' } } });
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId,
        item: { id: 'tier-status', type: 'agentMessage', text: JSON.stringify({ serviceTier: ctx.nativeTier ?? null }) } } });
      ctx.notify(turnCompleted(turnId));
    },
  },
  'streaming-before-terminal': {
    async onTurnStart(_params, ctx) {
      ctx.reply(ctx.currentId, { turn: { id: TURN_ID } });
      ctx.notify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } } });
      ctx.notify({ method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'live-answer', itemType: 'agentMessage', content: [] } } });
      for (const delta of ['first', ' and second']) {
        ctx.notify({ method: 'item/agentMessage/delta', params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'live-answer', delta } });
      }
      ctx.notify({ method: 'item/reasoning/summaryTextDelta', params: {
        threadId: THREAD_ID, turnId: TURN_ID, itemId: 'live-reasoning', delta: 'live reasoning' } });
      ctx.notify({ method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'empty-reasoning', type: 'reasoning', summary: [], content: [] } } });
      const requestId = ctx.nextServerId();
      ctx.serverRequest(requestId, 'item/commandExecution/requestApproval', {
        threadId: THREAD_ID, turnId: TURN_ID, itemId: 'live-command', command: 'fixture', reason: 'hold terminal' });
      await ctx.waitServerResponse(requestId);
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'live-answer', type: 'agentMessage', text: 'first and second; complete' } } });
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'live-reasoning', type: 'reasoning', summary: [], content: [] } } });
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'empty-reasoning', type: 'reasoning', summary: [], content: [] } } });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },
  'session-title': {
    async onThreadStart(params, ctx) {
      ctx.titleOnly = params.ephemeral === true;
      ctx.reply(ctx.currentId, makeThreadStartResponse(params));
    },
    async onTurnStart(_params, ctx) {
      ctx.reply(ctx.currentId, { turn: { id: TURN_ID } });
      ctx.notify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } } });
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'answer', type: 'agentMessage', phase: 'final_answer',
          text: ctx.titleOnly ? '{"title":"修复命令卡片"}' : 'Main task complete' } } });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },
  'whole-session-edits': {
    async onThreadRead(params, ctx) {
      if (params.fileChangesOnly !== undefined) {
        ctx.replyError(ctx.currentId, { code: -32602, message: 'unknown native parameter' });
        return;
      }
      ctx.reply(ctx.currentId, { thread: { id: params.threadId, turns: Array.from({ length: 40 }, (_, index) => ({
        id: `turn-${index}`, items: [
          { id: `edit-${index}`, type: 'fileChange', status: 'completed', changes: [{ path: `/file-${index}.ts`, kind: 'add', diff: '+created' }] },
          { id: `command-${index}`, type: 'commandExecution', command: 'inspect', aggregatedOutput: 'large output'.repeat(100) },
        ],
      })) } });
    },
  },
  'image-view': {
    async onTurnStart(_params, ctx) {
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } } });
      const item = { id: 'image-view', type: 'imageView', path: '/workspace/preview.png' };
      ctx.notify({ method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID, item } });
      ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId: TURN_ID, item } });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },
  /**
   * Notifications for turn/started and the userMessage item arrive BEFORE the
   * turn/start response; the body then streams and the turn completes once.
   */
  'resume-replayed-usage': {
    async onTurnStart(params, ctx) {
      // A cold resume's last-turn usage can reach the connection after this request was dispatched.
      ctx.notify({ method: 'turn/plan/updated', params: { threadId: THREAD_ID,
        turnId: 'restored-previous-turn', plan: [{ step: 'Old turn plan', status: 'completed' }] } });
      ctx.notify({ method: 'turn/diff/updated', params: { threadId: THREAD_ID,
        turnId: 'restored-previous-turn', diff: 'previous turn diff' } });
      ctx.notify({ method: 'thread/tokenUsage/updated', params: {
        threadId: THREAD_ID, turnId: 'restored-previous-turn', tokenUsage: {
          total: { inputTokens: 200, outputTokens: 50 }, last: { inputTokens: 40, outputTokens: 10 },
          modelContextWindow: 272000,
        },
      } });
      const turnId = `resumed-turn-${ctx.currentId}`;
      ctx.notify({ method: 'turn/started', params: {
        threadId: THREAD_ID, turn: { id: turnId, status: 'inProgress' },
      } });
      ctx.reply(ctx.currentId, { ...makeThreadStartResponse(params),
        turn: { id: turnId, status: 'inProgress', items: [] } });
      for (const item of [
        { id: 'restored-reasoning', type: 'reasoning', summary: ['Visible restored reasoning'], content: [] },
        { id: 'restored-agent', type: 'agentMessage', text: 'Visible restored response' },
        { id: 'restored-command', type: 'commandExecution', command: 'echo fixture',
          status: 'completed', aggregatedOutput: 'fixture', exitCode: 0 },
      ]) ctx.notify({ method: 'item/completed', params: { threadId: THREAD_ID, turnId, item } });
      ctx.notify(turnCompleted(turnId));
    },
  },

  'early-notification': {
    async onTurnStart(params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.notify({
        method: 'item/started',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-user-1', itemType: 'userMessage', clientId: params.clientUserMessageId || null, content: [{ type: 'text', text: 'hi' }] },
        },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-agent-1', itemType: 'agentMessage', content: [{ type: 'text', text: 'Hello from peer' }] },
        },
      });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /**
   * A command-approval reverse request (numeric id) during the turn; the turn
   * terminal follows the client's decision reply.
   */
  'reverse-approval': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      const reqId = ctx.nextServerId();
      ctx.serverRequest(reqId, 'item/commandExecution/requestApproval', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-cmd-1',
        command: ['npm', 'test'],
        cwd: '/tmp/codex-peer',
        reason: 'fixture approval',
        networkApprovalContext: null,
        additionalPermissions: null,
      });
      const decision = await ctx.waitServerResponse(reqId);
      ctx.notify({
        method: 'item/started',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-cmd-1', itemType: 'commandExecution', command: 'npm test', cwd: '/tmp/codex-peer', status: 'executing' },
        },
      });
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-cmd-1', itemType: 'commandExecution', command: 'npm test', cwd: '/tmp/codex-peer', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 },
        },
      });
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-agent-2', itemType: 'agentMessage', content: [{ type: 'text', text: `decision:${decision}` }] },
        },
      });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /** A verified child asks for approval while the parent turn terminates. */
  'child-interaction': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      const reqId = ctx.nextServerId();
      ctx.serverRequest(reqId, 'item/commandExecution/requestApproval', {
        threadId: CHILD_THREAD_ID,
        turnId: 'turn-child-0001',
        itemId: 'item-child-approval',
        command: ['echo', 'child'],
        cwd: '/tmp/codex-peer',
        reason: 'child fixture approval',
      });
      // The parent may finish while the child request is still actionable.
      ctx.notify(turnCompleted(TURN_ID));
      await ctx.waitServerResponse(reqId);
      ctx.notify({
        method: 'turn/completed',
        params: {
          threadId: CHILD_THREAD_ID,
          turn: { id: 'turn-child-0001', status: 'completed', error: null },
        },
      });
    },
    async onThreadRead(params, ctx) {
      const response = makeThreadStartResponse({ threadId: params?.threadId });
      response.thread.parentThreadId = THREAD_ID;
      ctx.reply(ctx.currentId, response);
    },
  },

  /** File approval follows a native file item carrying a multi-file patch. */
  'file-approval-with-item': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify({
        method: 'item/started',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: {
            id: 'item-file-approval',
            type: 'fileChange',
            changes: [
              { path: 'src/added.ts', kind: 'add', diff: '+export const added = true;' },
              { path: 'src/removed.ts', kind: 'delete', diff: '-export const removed = true;' },
              { path: 'src/changed.ts', kind: 'update', diff: '@@ -1 +1 @@' },
            ],
          },
        },
      });
      const reqId = ctx.nextServerId();
      ctx.serverRequest(reqId, 'item/fileChange/requestApproval', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-file-approval',
        reason: 'fixture file approval',
      });
      await ctx.waitServerResponse(reqId);
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-file-approval', type: 'fileChange', status: 'completed' },
        },
      });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /** File approval has no cached item; read-only hydration returns no match. */
  'file-approval-missing-item': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      const reqId = ctx.nextServerId();
      ctx.serverRequest(reqId, 'item/fileChange/requestApproval', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-file-not-found',
        reason: 'fixture missing preview',
      });
      await ctx.waitServerResponse(reqId);
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /** Native MCP form elicitation with an action/content response union. */
  'mcp-elicitation': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      const reqId = ctx.nextServerId();
      ctx.serverRequest(reqId, 'mcpServer/elicitation/request', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        serverName: 'fixture-mcp',
        request: {
          mode: 'form',
          message: 'Provide a fixture value',
          requestedSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      });
      const response = await ctx.waitServerResponse(reqId);
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-mcp-result', itemType: 'agentMessage', content: [{ type: 'text', text: JSON.stringify(response) }] },
        },
      });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /**
   * Terminal notification is duplicated and a late item follows the terminal.
   */
  'duplicate-terminal': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-agent-3', itemType: 'agentMessage', content: [{ type: 'text', text: 'only once' }] },
        },
      });
      ctx.notify(turnCompleted(TURN_ID));
      ctx.notify(turnCompleted(TURN_ID));
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-agent-4', itemType: 'agentMessage', content: [{ type: 'text', text: 'after terminal' }] },
        },
      });
    },
  },

  /** Child process dies after turn/start was accepted; no terminal arrives. */
  'disconnect-mid-turn': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-agent-5', itemType: 'agentMessage', content: [{ type: 'text', text: 'dying now' }] },
        },
      });
      setImmediate(() => ctx.exit(1, 'disconnect-mid-turn'));
    },
  },

  /** Writes a large stderr flood while the turn keeps making progress. */
  'stderr-flood': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.stderr('#'.repeat(4096) + '\n');
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-agent-6', itemType: 'agentMessage', content: [{ type: 'text', text: 'survived stderr flood' }] },
        },
      });
      ctx.stderr('#'.repeat(4096) + '\n');
      ctx.notify(turnCompleted(TURN_ID));
      for (let i = 0; i < 256; i += 1) {
        ctx.stderr('#'.repeat(4096) + '\n');
      }
    },
  },

  /**
   * A server request reuses the numeric id the client also used for an
   * outstanding request; both directions must resolve independently.
   */
  'numeric-id-collision': {
    async onTurnStart(_params, ctx) {
      // Client request ids start at 1, so this server request id collides with
      // the client's first in-flight request when routed through one map.
      ctx.serverRequest(1, 'item/commandExecution/requestApproval', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-cmd-collide',
        command: ['echo', 'collision'],
        cwd: '/tmp/codex-peer',
        reason: null,
        networkApprovalContext: null,
        additionalPermissions: null,
      });
      await ctx.waitServerResponse(1);
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /** Reverse request carrying a string id (type preservation check). */
  'string-id-reverse': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      const reqId = 'server-fixture-77';
      ctx.serverRequest(reqId, 'item/commandExecution/requestApproval', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-cmd-str',
        command: ['echo', 'string-id'],
        cwd: '/tmp/codex-peer',
        reason: null,
        networkApprovalContext: null,
        additionalPermissions: null,
      });
      const decision = await ctx.waitServerResponse(reqId);
      ctx.notify(turnCompleted(TURN_ID, decision === 'accept' ? 'completed' : 'interrupted'));
    },
  },

  /**
   * Reverse request with notifications flowing WHILE the approval is open —
   * proves the client reader loop never blocks on a UI wait.
   */
  'reverse-approval-with-traffic': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      const reqId = ctx.nextServerId();
      ctx.serverRequest(reqId, 'item/commandExecution/requestApproval', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item-cmd-traffic',
        command: ['npm', 'test'],
        cwd: '/tmp/codex-peer',
        reason: null,
        networkApprovalContext: null,
        additionalPermissions: null,
      });
      // Traffic while the approval is open.
      ctx.notify({
        method: 'item/started',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item-agent-traffic', itemType: 'agentMessage', content: [{ type: 'text', text: 'while approval open' }] },
        },
      });
      await ctx.waitServerResponse(reqId);
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /** turn/start is notified but never acknowledged (late-ack fixtures). */
  'never-respond': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      // No ack, no terminal. Late acks can be driven by replying through the
      // fixture harness when the test needs one.
      ctx.rememberPendingAck(ctx.currentId);
    },
  },

  /**
   * turn/start receives nothing at all — no ack, no notification. This is the
   * "written but identity unknown" fixture for stop semantics.
   */
  'silent-start': {
    async onTurnStart(_params, ctx) {
      ctx.rememberPendingAck(ctx.currentId);
      // Silence. The test can ack later via ackPending.
    },
  },

  /** Emits a JSON message split across two writes, then two in one chunk. */
  'broken-framing': {
    async onThreadStart(_params, ctx) {
      const response = JSON.stringify({ id: ctx.currentId, result: makeThreadStartResponse() });
      const half = Math.floor(response.length / 2);
      ctx.raw(response.slice(0, half));
      await ctx.sleep(20);
      ctx.raw(response.slice(half) + '\n');
      // Two frames inside one chunk must both parse.
      const one = JSON.stringify({ method: 'peer/notice', params: { n: 1 } });
      const two = JSON.stringify({ method: 'peer/notice', params: { n: 2 } });
      ctx.raw(one + '\n' + two + '\n');
    },
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /** Rejects initialize so callers can verify startup failure handling. */
  'initialize-refusal': {
    onInitialize(_params, ctx) {
      ctx.replyError(ctx.currentId, { code: -32000, message: 'peer refuses initialization' });
      ctx.exit(0, 'initialize-refused');
    },
  },

  /** Sends an unknown server request and an unknown notification; continues. */
  'unknown-server-request': {
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      // Unknown notification must not disturb the active turn.
      ctx.notify({
        method: 'peer/__futureFeature',
        params: { opaque: true },
      });
      const reqId = ctx.nextServerId();
      ctx.serverRequest(reqId, 'item/__peerUnknown/requestApproval', { threadId: THREAD_ID });
      await ctx.waitServerResponse(reqId);
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /**
   * Responds to thread/resume with a thread plus metadata-only turns so
   * history paging fixtures can exercise the metadata-only path.
   */
  'resume-metadata-only': {
    async onThreadResume(params, ctx) {
      ctx.reply(ctx.currentId, {
        thread: makeThreadStartResponse(params).thread,
        turns: [],
        hasMoreTurns: true,
        nextCursor: 'cursor-metadata-1',
      });
    },
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify(turnCompleted(TURN_ID));
    },
  },

  /** A loaded idle writer in another server still excludes a cold resume. */
  'resume-writer-conflict': {
    async onThreadResume(params, ctx) {
      ctx.replyError(ctx.currentId, { code: -32600, message: `thread ${params.threadId} already has an active writer` });
    },
  },

  /** Compact remains active until the client explicitly interrupts its native turn. */
  'compact-until-interrupt': {
    async onCompactStart(_params, ctx) {
      ctx.reply(ctx.currentId, {});
      ctx.notify({ method: 'turn/started', params: { threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'inProgress' } } });
      ctx.notify({ method: 'item/started', params: { threadId: THREAD_ID, turnId: TURN_ID,
        item: { id: 'compact-interrupted-item', type: 'contextCompaction' } } });
    },
  },

  /** Native catalog/history responses used by read-only integration tests. */
  'native-read-only': {
    async onThreadStart(_params, ctx) {
      ctx.reply(ctx.currentId, makeThreadStartResponse());
    },
  },

  /** A saved plan changes after its local completed snapshot. */
  'native-plan-replaced': {
    onTurnStart(params, ctx) { return SCENARIOS['native-items'].onTurnStart(params, ctx); },
    async onTurnsList(_params, ctx) {
      ctx.reply(ctx.currentId, { data: [{ id: TURN_ID, status: 'completed', items: [
        { id: 'plan-1', type: 'plan', text: 'changed native plan', status: 'completed' },
      ] }], nextCursor: null });
    },
  },

  /** Another writer starts a turn after the reviewed native plan. */
  'native-plan-superseded': {
    onTurnStart(params, ctx) { return SCENARIOS['native-items'].onTurnStart(params, ctx); },
    async onTurnsList(_params, ctx) {
      ctx.reply(ctx.currentId, { data: [{ id: 'newer-turn', status: 'completed', items: [
        { id: 'plan-1', type: 'plan', text: 'authoritative plan', status: 'completed' },
      ] }], nextCursor: null });
    },
  },

  /** Streams a plan item, a multi-file proposal and visible generic items. */
  'native-items': {
    async onTurnsList(_params, ctx) {
      ctx.reply(ctx.currentId, { data: [{ id: TURN_ID, status: 'completed', items: [
        { id: 'plan-1', type: 'plan', text: 'authoritative plan', status: 'completed' },
      ] }], nextCursor: null });
    },
    async onTurnStart(_params, ctx) {
      ctx.notify({
        method: 'turn/started',
        params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } },
      });
      ctx.reply(ctx.currentId, makeThreadStartResponse());
      ctx.notify({
        method: 'item/plan/delta',
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'plan-1', delta: 'draft' },
      });
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'plan-1', type: 'plan', text: 'authoritative plan', status: 'completed' },
        },
      });
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: {
            id: 'file-1',
            type: 'fileChange',
            status: 'proposed',
            changes: {
              'src/new.ts': { kind: 'add', diff: '+new' },
              'src/old.ts': { kind: 'rename', newPath: 'src/renamed.ts', diff: '@@' },
            },
          },
        },
      });
      ctx.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'web-1', type: 'webSearch', query: 'fixture', results: [{ title: 'fixture' }] },
        },
      });
      ctx.notify(turnCompleted(TURN_ID));
    },
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

class PeerContext {
  constructor({ scenario, trace, quiet, output = process.stdout, writeStderr = null, onExit = null }) {
    this.scenario = scenario;
    this.trace = trace;
    this.quiet = quiet;
    this.output = output;
    this.writeStderrFn = writeStderr || ((text) => process.stderr.write(text));
    this.onExitFn = onExit || ((code) => process.exit(code));
    this.currentId = null;
    this.nextServerRequestId = 100;
    this.serverWaiters = new Map();
    this.pendingAcks = new Map();
    this.handled = new Set();
    this.finished = false;
  }

  /** Records an un-acked client request id so tests can ack it later. */
  rememberPendingAck(id) {
    if (id !== null && id !== undefined) {
      this.pendingAcks.set(id, true);
    }
  }

  ackPending(id, result) {
    if (this.pendingAcks.has(id)) {
      this.pendingAcks.delete(id);
      this.reply(id, result ?? makeThreadStartResponse());
      return true;
    }
    return false;
  }

  raw(text) {
    this.output.write(text);
    if (this.trace) this.trace.record('peer_raw', { bytes: text.length });
  }

  line(obj) {
    this.raw(JSON.stringify(obj) + '\n');
  }

  notify(msg) {
    if (this.trace) this.trace.record('notify', { method: msg.method });
    this.line({ method: msg.method, params: msg.params });
  }

  reply(id, result) {
    if (this.trace) this.trace.record('response', { id });
    this.line({ id, result });
  }

  replyError(id, error) {
    if (this.trace) this.trace.record('response_error', { id, code: error?.code ?? null });
    this.line({ id, error });
  }

  serverRequest(id, method, params) {
    if (this.trace) this.trace.record('server_request', { id, method });
    this.line({ id, method, params });
  }

  nextServerId() {
    return this.nextServerRequestId++;
  }

  waitServerResponse(id) {
    return new Promise((resolvePromise) => {
      this.serverWaiters.set(id, { resolve: resolvePromise });
    });
  }

  sleep(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
  }

  exit(code = 0, reason = 'scenario-exit') {
    if (this.finished) return;
    this.finished = true;
    if (this.trace) this.trace.record('exit', { code, reason });
    this.onExitFn(code, reason);
  }

  stderr(text) {
    this.writeStderrFn(text);
    if (this.trace) this.trace.record('stderr', { bytes: text.length });
  }

  async dispatch(method, params, id) {
    this.currentId = id;
    if (method === 'initialize') {
      if (this.scenario.onInitialize) {
        await this.scenario.onInitialize(params, this);
        return;
      }
      this.reply(id, { userAgent: 'codex-test-peer/1.0', authMode: null });
      return;
    }
    if (method === 'initialized') {
      if (this.trace) this.trace.record('initialized');
      return;
    }
    const handlers = [
      ['thread/start', 'onThreadStart'],
      ['thread/resume', 'onThreadResume'],
      ['turn/start', 'onTurnStart'],
      ['turn/interrupt', 'onTurnInterrupt'],
      ['thread/compact/start', 'onCompactStart'],
    ];
    for (const [name, hook] of handlers) {
      if (method === name && this.scenario[hook]) {
        await this.scenario[hook](params, this);
        return;
      }
    }
    if (method === 'turn/interrupt') {
      this.reply(id, {});
      this.notify(turnCompleted(TURN_ID, 'interrupted'));
      return;
    }
    if (method === 'thread/settings/update') {
      // Ack the request, then confirm effectiveness via the notification.
      this.reply(id, {});
      this.notify({
        method: 'thread/settings/updated',
        params: { ...params, ...(Object.hasOwn(params ?? {}, 'serviceTier')
          ? { serviceTier: normalizedServiceTier(params.serviceTier) } : {}) },
      });
      return;
    }
    if (method === 'thread/compact/start') {
      const compactTurnId = `turn-compact-${id}`;
      this.reply(id, {});
      this.notify({
        method: 'item/started',
        params: { threadId: THREAD_ID, turnId: null, item: { id: 'item-compact-1', itemType: 'contextCompaction' } },
      });
      this.notify({
        method: 'item/completed',
        params: {
          threadId: THREAD_ID,
          turnId: compactTurnId,
          item: {
            id: 'item-compact-1',
            type: 'contextCompaction',
            text: 'manual compact summary',
            status: 'completed',
          },
        },
      });
      this.notify(turnCompleted(compactTurnId));
      return;
    }
    if (method === 'thread/list') {
      this.reply(id, { data: [{ id: THREAD_ID, cwd: '/tmp/codex-peer', source: 'appServer' }], nextCursor: null });
      return;
    }
    if (method === 'thread/name/set') {
      this.threadNames ??= new Map();
      this.threadNames.set(params.threadId, params.name);
      this.reply(id, {});
      this.notify({ method: 'thread/name/updated', params: { threadId: params.threadId, threadName: params.name } });
      return;
    }
    if (method === 'config/read') {
      this.reply(id, { config: { project_doc_fallback_filenames: [] }, layers: null });
      return;
    }
    if (method === 'thread/read') {
      if (this.scenario.onThreadRead) {
        await this.scenario.onThreadRead(params, this);
        return;
      }
      this.reply(id, { thread: { ...makeThreadStartResponse(params || {}).thread,
        name: this.threadNames?.get(params?.threadId) ?? null,
        turns: params?.includeTurns ? [makeNativeHistoryTurn()] : [] } });
      return;
    }
    if (method === 'thread/turns/list') {
      if (this.scenario.onTurnsList) {
        await this.scenario.onTurnsList(params, this);
        return;
      }
      this.reply(id, { data: [makeNativeHistoryTurn()], nextCursor: null });
      return;
    }
    if (method === 'thread/items/list') {
      this.reply(id, { data: [{ turnId: 'history-turn', item: { id: 'item-history-1', type: 'agentMessage', text: 'history' } }], nextCursor: null });
      return;
    }
    if (method === 'model/list') {
      this.reply(id, { data: [{ id: 'test-model', model: 'test-model', displayName: 'Test model', supportedReasoningEfforts: ['medium'] }], nextCursor: null });
      return;
    }
    if (method === 'skills/list') {
      this.reply(id, { data: [{ cwd: params?.cwds?.[0] ?? '/tmp/codex-peer',
        skills: [{ name: 'test-skill', path: '/tmp/codex-peer/.agents/skills/test-skill', enabled: true }], errors: [] }] });
      return;
    }
    if (method === 'mcpServerStatus/list') {
      this.reply(id, { data: [{ name: 'fixture-mcp', runtimeStatus: 'connected', authStatus: 'unsupported', tools: {} }], nextCursor: null });
      return;
    }
    if (method === 'config/mcpServer/reload') {
      this.reply(id, { reloaded: true });
      return;
    }
    if (method === 'thread/start') {
      // Default thread/start response when the scenario has no hook.
      this.reply(id, makeThreadStartResponse(params || {}));
      return;
    }
    if (method === 'thread/resume') {
      this.reply(id, {
        thread: makeThreadStartResponse(params || {}).thread,
        turns: [],
        hasMoreTurns: false,
        nextCursor: null,
      });
      return;
    }
    // Unknown methods: default protocol answer is an error response.
    this.replyError(id, { code: -32601, message: `peer has no handler for ${method}` });
  }
}

/**
 * Wire the peer to explicit streams. Returns the context so in-process tests
 * can drive fixtures (e.g. ackPending) and write client frames into `input`.
 */
export function startPeerWithStreams({
  scenario: scenarioName,
  trace: tracePath,
  input,
  output,
  stderr = null,
  onExit = null,
} = {}) {
  const scenario = SCENARIOS[scenarioName || 'early-notification'];
  if (!scenario) {
    throw new Error(`unknown peer scenario: ${scenarioName}. Available: ${SCENARIO_NAMES.join(', ')}`);
  }
  const trace = new PeerTrace(tracePath);
  const ctx = new PeerContext({
    scenario,
    trace,
    output,
    writeStderr: stderr ? (text) => stderr.write(text) : null,
    onExit: onExit || null,
  });
  attachPeerInput(ctx, input, trace);
  return ctx;
}

function attachPeerInput(ctx, input, trace) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    handlePeerLine(ctx, line, trace);
  });
  rl.on('close', () => {
    ctx.exit(0, 'stdin-closed');
  });
}

function handlePeerLine(ctx, line, trace) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    if (trace) trace.record('unparseable_client_line', {});
    return;
  }
  if (trace) trace.record('client_message', { hasId: msg.id !== undefined, method: msg.method || null,
    threadId: msg.params?.threadId, turnId: msg.params?.turnId });
  if (typeof msg.id !== 'undefined' && msg.method) {
    ctx.dispatch(msg.method, msg.params || {}, msg.id);
    return;
  }
  if (typeof msg.id !== 'undefined' && (msg.result !== undefined || msg.error !== undefined)) {
    const waiter = ctx.serverWaiters.get(msg.id);
    if (waiter) {
      ctx.serverWaiters.delete(msg.id);
      if (trace) trace.record('server_response', { id: msg.id });
      waiter.resolve(msg.result);
      return;
    }
    // A late ack for a never-respond scenario (test-driven).
    if (ctx.ackPending(msg.id, msg.result)) {
      if (trace) trace.record('late_ack', { id: msg.id });
    }
    return;
  }
  if (msg.method) {
    ctx.dispatch(msg.method, msg.params || {}, null);
  }
}

/** Process entry point: wire the peer to stdin/stdout/stderr. */
export function startPeer({ scenario: scenarioName, trace: tracePath, quiet } = {}) {
  const peer = startPeerWithStreams({
    scenario: scenarioName,
    trace: tracePath,
    input: process.stdin,
    output: process.stdout,
    stderr: { write: (text) => process.stderr.write(text) },
  });
  peer.trace?.record('peer_started', { pid: process.pid });
  return peer;
}

function parseArgs(argv) {
  const args = { scenario: 'early-notification', trace: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--scenario') args.scenario = argv[++i];
    else if (arg === '--trace') args.trace = argv[++i];
    else if (arg === '--quiet') args.quiet = true;
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const dir = dirname(fileURLToPath(import.meta.url));
  startPeer({
    scenario: args.scenario,
    trace: args.trace ? resolve(dir, args.trace) : null,
    quiet: args.quiet,
  });
}
