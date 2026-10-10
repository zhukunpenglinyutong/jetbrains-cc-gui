import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const writesByFile = new Map();
const UNCLASSIFIED_MASK = '[redacted answer: classification unavailable]';
const CONTENT_TYPES = new Set(['text', 'image', 'inputText', 'inputImage', 'inputAudio', 'url', 'base64']);

/**
 * Stores only secret-question identity metadata owned by the plugin.
 * Answers and question text never enter this file.
 */
export class CodexPrivacyIndex {
  constructor({ rootDir, scope = 'default' } = {}) {
    if (!rootDir) throw new Error('CodexPrivacyIndex requires rootDir');
    this.rootDir = rootDir;
    this.scope = String(scope);
    const scopeFingerprint = createHash('sha256').update(this.scope).digest('hex');
    this.filePath = join(rootDir, `${scopeFingerprint}.json`);
    this.recordPrefix = `${scopeFingerprint}.record.`;
    this.entries = [];
    this.conservativeMasking = false;
  }

  /** Load the persisted identity index before the first native item arrives. */
  async load() {
    const entries = [];
    let uncertain = false;
    try {
      const names = await readdir(this.rootDir);
      for (const name of names.filter((name) => name === basename(this.filePath)
        || name.startsWith(this.recordPrefix) && name.endsWith('.json'))) {
        try {
          const state = readPrivacyState(await readFile(join(this.rootDir, name), 'utf8'));
          entries.push(...state.entries);
          uncertain ||= state.conservativeMasking;
        } catch {
          uncertain = true;
        }
      }
    } catch (error) {
      uncertain = error?.code !== 'ENOENT';
    }
    this.entries = entries;
    this.conservativeMasking = uncertain;
  }

  async record(identity) {
    const previous = writesByFile.get(this.filePath) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.#recordIdentity(identity));
    writesByFile.set(this.filePath, pending);
    try { await pending; } finally {
      if (writesByFile.get(this.filePath) === pending) writesByFile.delete(this.filePath);
    }
  }

  async #recordIdentity({ threadId = null, turnId = null, callId = null, itemId = null, method, params }) {
    // MCP RPC identity is not a tool-call identity. Without an associated item,
    // protect output in the correlated turn (or thread when turn is unknown).
    if (method === 'mcpServer/elicitation/request' && !itemId) callId = null;
    const request = params?.request ?? params;
    const properties = request?.requestedSchema?.properties;
    const questions = Array.isArray(params?.questions) ? params.questions
      : properties && typeof properties === 'object' ? Object.entries(properties).map(([id, field]) => ({
        id, isSecret: field?.isSecret === true || field?.writeOnly === true || field?.format === 'password',
      })) : [];
    const secretQuestionIds = questions
      .filter((question) => question?.isSecret === true || question?.secret === true)
      .map((question) => question.id)
      .filter((id) => typeof id === 'string' && id.length > 0);
    if (questions.length === 0) return;

    const key = [threadId, turnId, callId, itemId, method].map((value) => String(value ?? '')).join('\u0000');
    await this.load();
    const entry = {
      key,
      threadId,
      turnId,
      callId,
      itemId,
      method,
      secretQuestionIds,
      questionIds: questions.map((question) => question.id).filter((id) => typeof id === 'string'),
      recordedAt: Date.now(),
    };
    await mkdir(this.rootDir, { recursive: true });
    // Each completed record has a fresh destination. Different Node daemons
    // cannot replace one another's classifications or a corrupt legacy index.
    const targetPath = join(this.rootDir, `${this.recordPrefix}${randomUUID()}.json`);
    const tempPath = `${targetPath}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify({ version: 1, entries: [entry],
        ...(this.conservativeMasking ? { conservativeMasking: true } : {}) }) + '\n', { encoding: 'utf8', flag: 'wx' });
      await rename(tempPath, targetPath);
    } finally {
      await unlink(tempPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    }
    this.entries.push(entry);
  }

  /** Whether an item belongs to a recorded secret interaction scope. */
  isSecretIdentity({ threadId = null, turnId = null, callId = null, itemId = null } = {}) {
    return this.matchingEntries({ threadId, turnId, callId, itemId }).some((entry) => entry.secretQuestionIds?.length > 0);
  }

  matchingEntries(identity) {
    const ids = [identity.callId, identity.itemId].filter(Boolean).map(normalizeResultId);
    const matching = this.entries.filter((entry) => {
      if (identity.threadId && entry.threadId && identity.threadId !== entry.threadId) return false;
      if (identity.turnId && entry.turnId && identity.turnId !== entry.turnId) return false;
      const recorded = [entry.callId, entry.itemId].filter(Boolean);
      if (recorded.length) return ids.some((id) => recorded.includes(id));
      return Boolean(identity.threadId && entry.threadId === identity.threadId
        && (entry.turnId ? entry.turnId === identity.turnId
          : entry.method === 'mcpServer/elicitation/request'));
    });
    const strong = matching.filter((entry) => entry.callId || entry.itemId);
    return strong.length ? strong : matching;
  }

  /**
   * Redact plugin-controlled projections of a secret interaction. Identity
   * fields remain visible so stable item upsert and diagnostics still work.
   */
  redact(value, identity = {}) {
    return redactValue(value, identity, this, false);
  }

  /** Return question ids whose answers must remain masked in history projections. */
  secretQuestionIds() {
    return this.entries.flatMap((entry) => entry.secretQuestionIds || []);
  }
}

const IDENTITY_KEYS = new Set([
  'id', 'type', 'status', 'threadId', 'thread_id', 'turnId', 'turn_id',
  'itemId', 'item_id', 'callId', 'call_id', 'clientId', 'client_id',
  'questionId', 'question_id', 'method', 'server', 'tool', 'name', 'path', 'cwd',
]);

function normalizeResultId(id) {
  return typeof id === 'string' ? id.replace(/:result$/, '') : id;
}

function inheritIdentity(value, parent) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return parent;
  const turn = Array.isArray(value.items) && value.id;
  return {
    ...parent,
    threadId: value.threadId ?? value.thread_id ?? value.codexThreadId ?? parent.threadId,
    turnId: value.turnId ?? value.turn_id ?? value.codexTurnId ?? (turn ? value.id : parent.turnId),
    itemId: value.itemId ?? value.item_id ?? value.codexItemId
      ?? (typeof value.type === 'string' && value.id ? value.id : turn ? null : parent.itemId),
    callId: value.callId ?? value.call_id ?? value.tool_use_id ?? (turn ? null : parent.callId),
  };
}

function redactValue(value, inherited, index, forcedMask, outputBody = false) {
  const identity = outputBody ? inherited : inheritIdentity(value, inherited);
  const entries = index.matchingEntries(identity);
  // Question names are reused across calls. Only a concrete, matching call in
  // the correct thread can establish that an ordinary answer is safe to show.
  const classified = entries.filter((entry) => identity.threadId && entry.threadId === identity.threadId
    && (!entry.turnId || entry.turnId === identity.turnId) && (entry.callId || entry.itemId));
  const classifiedIds = new Set(classified.flatMap((entry) => entry.questionIds ?? []));
  const secretQuestionIds = new Set(entries.flatMap((entry) => entry.secretQuestionIds ?? []));
  const protectOutput = index.conservativeMasking || secretQuestionIds.size > 0;
  // Classification applies to answers and result bodies. Masking a whole
  // thread would erase reasoning and turn timestamps into invalid strings.
  const mask = forcedMask;
  if (typeof value === 'string') {
    if (outputBody && /"answers"\s*:/.test(value) && /^[{[]/.test(value.trimStart())) {
      try {
        return JSON.stringify(redactValue(JSON.parse(value), identity, index, mask, true));
      } catch { return UNCLASSIFIED_MASK; }
    }
    return mask ? '[redacted secret answer]' : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, identity, index, forcedMask, outputBody));
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return mask && value !== null && value !== undefined ? '[redacted secret answer]' : value;
  }
  const result = Object.create(null);
  const secretQuestion = [value.id, value.questionId, value.question_id]
    .some((id) => typeof id === 'string' && secretQuestionIds.has(id));
  for (const [key, child] of Object.entries(value)) {
    if (key === 'answers') {
      result.answers = child && typeof child === 'object' && !Array.isArray(child)
        ? Object.fromEntries(Object.entries(child).map(([id, answer]) => [id,
          !index.conservativeMasking && classifiedIds.has(id)
            ? secretQuestionIds.has(id) ? '[redacted secret answer]' : answer : UNCLASSIFIED_MASK,
        ])) : UNCLASSIFIED_MASK;
      continue;
    }
    const output = ['output', 'result', 'aggregatedOutput', 'stdout', 'stderr', 'contentItems'].includes(key)
      || key === 'content' && ['tool_result', 'functionCallOutput', 'function_call_output'].includes(value.type)
      || key === 'error' && ['mcpToolCall', 'mcp_tool_call', 'dynamicToolCall'].includes(value.type);
    const childSecret = mask || protectOutput && output || secretQuestion && (key === 'answer' || key === 'value');
    result[key] = !mask && IDENTITY_KEYS.has(key) || mask && key === 'type' && CONTENT_TYPES.has(child)
      ? child
      : redactValue(child, key === 'thread' && child?.id ? { threadId: child.id } : identity, index, childSecret, outputBody || output);
  }
  // Spread creates own data properties even for schema fields such as __proto__.
  return { ...result };
}

function readPrivacyState(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { entries: [], conservativeMasking: true }; }
  if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) return { entries: [], conservativeMasking: true };
  const entries = parsed.entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && ['threadId', 'turnId', 'callId', 'itemId'].every((key) => entry[key] == null
      || typeof entry[key] === 'string' || typeof entry[key] === 'number' && Number.isFinite(entry[key]))
    && Array.isArray(entry.secretQuestionIds) && entry.secretQuestionIds.every((id) => typeof id === 'string')
    && (entry.questionIds == null || Array.isArray(entry.questionIds) && entry.questionIds.every((id) => typeof id === 'string')));
  return { entries, conservativeMasking: parsed.conservativeMasking === true
    || parsed.conservativeMasking !== undefined && typeof parsed.conservativeMasking !== 'boolean'
    || entries.length !== parsed.entries.length };
}
