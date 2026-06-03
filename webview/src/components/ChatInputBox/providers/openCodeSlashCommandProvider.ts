import type { CommandItem } from '../types';
import { sendBridgeEvent } from '../../../utils/bridge';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';
import { slashCommandProvider } from './slashCommandProvider';

type LoadingState = 'idle' | 'loading' | 'success' | 'failed';

const OPENCODE_COMMAND_PREFIX = 'opencode-command:';
const BUILTIN_GROUP_ID = '__opencode_builtin_commands__';
const OPENCODE_GROUP_ID = '__opencode_native_commands__';

let cachedCommands: CommandItem[] = [];
let loadingState: LoadingState = 'idle';
let lastRefreshTime = 0;
let callbackRegistered = false;
let retryCount = 0;
let pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];

const MIN_REFRESH_INTERVAL = 2000;
const LOADING_TIMEOUT = 3000;
const MAX_RETRY_COUNT = 2;

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isSafeOpenCodeCommandName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value);
}

function normalizeOpenCodeCommand(raw: unknown): CommandItem | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate.source === 'skill') {
    return null;
  }

  const name = asNonEmptyString(candidate.name) ?? asNonEmptyString(candidate.commandName);
  if (!name || !isSafeOpenCodeCommandName(name)) {
    return null;
  }

  const source = asNonEmptyString(candidate.source) ?? 'command';
  const description = asNonEmptyString(candidate.description);
  const sourceSuffix = source === 'mcp' ? ' [mcp]' : '';

  return {
    id: `${OPENCODE_COMMAND_PREFIX}${name}`,
    label: `/${name}`,
    description: description ? `${description}${sourceSuffix}` : sourceSuffix.trim(),
    category: source === 'mcp' ? 'mcp' : 'opencode',
    provider: 'opencode',
    commandName: name,
    source,
  };
}

export function parseOpenCodeCommandPayload(payload: string): CommandItem[] {
  const parsed = JSON.parse(payload);
  const rawCommands = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.commands) ? parsed.commands : [];
  const seen = new Set<string>();
  const commands: CommandItem[] = [];

  for (const rawCommand of rawCommands) {
    const command = normalizeOpenCodeCommand(rawCommand);
    if (!command || seen.has(command.label)) {
      continue;
    }
    seen.add(command.label);
    commands.push(command);
  }

  return commands.sort((a, b) => a.label.localeCompare(b.label));
}

function sectionHeader(id: string, label: string): CommandItem {
  return {
    id,
    label,
    kind: 'section-header',
    category: 'system',
  };
}

function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  if (!query) return commands;

  const lowerQuery = query.toLowerCase();
  return commands.filter((command) =>
    command.label.toLowerCase().includes(lowerQuery) ||
    command.description?.toLowerCase().includes(lowerQuery) ||
    command.id.toLowerCase().includes(lowerQuery) ||
    command.commandName?.toLowerCase().includes(lowerQuery)
  );
}

export function mergeOpenCodeSlashCommandGroups(
  builtinCommands: CommandItem[],
  openCodeCommands: CommandItem[]
): CommandItem[] {
  const result: CommandItem[] = [];
  const builtinLabels = new Set(builtinCommands.map((command) => command.label));
  const nativeCommands = openCodeCommands.filter((command) => !builtinLabels.has(command.label));

  if (builtinCommands.length > 0) {
    result.push(sectionHeader(BUILTIN_GROUP_ID, 'Built-in commands'), ...builtinCommands);
  }
  if (nativeCommands.length > 0) {
    result.push(sectionHeader(OPENCODE_GROUP_ID, 'OpenCode commands'), ...nativeCommands);
  }

  return result.length > 0 ? result : [];
}

export function resetOpenCodeSlashCommandsState() {
  cachedCommands = [];
  loadingState = 'idle';
  lastRefreshTime = 0;
  retryCount = 0;
  pendingWaiters.forEach(w => w.reject(new Error('opencode slash commands state reset')));
  pendingWaiters = [];
  debugLog('[OpenCodeSlashCommandProvider] State reset');
}

export function setupOpenCodeSlashCommandsCallback() {
  if (typeof window === 'undefined') return;
  if (callbackRegistered && window.updateOpenCodeCommands) return;

  const handler = (json: string) => {
    debugLog('[OpenCodeSlashCommandProvider] Received data from backend, length=' + json.length);

    try {
      cachedCommands = parseOpenCodeCommandPayload(json);
      loadingState = 'success';
      retryCount = 0;
      pendingWaiters.forEach(w => w.resolve());
      pendingWaiters = [];
      debugLog('[OpenCodeSlashCommandProvider] Successfully loaded ' + cachedCommands.length + ' commands');
    } catch (error) {
      loadingState = 'failed';
      pendingWaiters.forEach(w => w.reject(error));
      pendingWaiters = [];
      debugError('[OpenCodeSlashCommandProvider] Failed to parse commands:', error);
    }
  };

  const originalHandler = window.updateOpenCodeCommands;
  window.updateOpenCodeCommands = (json: string) => {
    handler(json);
    originalHandler?.(json);
  };

  callbackRegistered = true;
  debugLog('[OpenCodeSlashCommandProvider] Callback registered');
}

function waitForCommands(signal: AbortSignal, timeoutMs: number): Promise<void> {
  if (loadingState === 'success') return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const waiter = { resolve: () => {}, reject: (_error: unknown) => {} } as {
      resolve: () => void;
      reject: (error: unknown) => void;
    };

    const cleanup = () => {
      pendingWaiters = pendingWaiters.filter(w => w !== waiter);
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error('opencode slash commands loading timeout'));
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });

    waiter.resolve = () => {
      cleanup();
      resolve();
    };
    waiter.reject = (error: unknown) => {
      cleanup();
      reject(error);
    };

    pendingWaiters.push(waiter);
  });
}

function requestRefresh(): boolean {
  const now = Date.now();

  if (now - lastRefreshTime < MIN_REFRESH_INTERVAL) {
    debugLog('[OpenCodeSlashCommandProvider] Skipping refresh (too soon)');
    return false;
  }

  if (retryCount >= MAX_RETRY_COUNT) {
    debugWarn('[OpenCodeSlashCommandProvider] Max retry count reached, giving up');
    loadingState = 'failed';
    return false;
  }

  const attempt = retryCount + 1;
  const sent = sendBridgeEvent('get_opencode_commands');
  if (!sent) {
    debugLog('[OpenCodeSlashCommandProvider] Bridge not available yet, refresh not sent');
    return false;
  }

  lastRefreshTime = now;
  loadingState = 'loading';
  retryCount = attempt;

  debugLog('[OpenCodeSlashCommandProvider] Requesting refresh from backend (attempt ' + retryCount + '/' + MAX_RETRY_COUNT + ')');
  return true;
}

export async function openCodeSlashCommandProvider(
  query: string,
  signal: AbortSignal
): Promise<CommandItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupOpenCodeSlashCommandsCallback();

  const now = Date.now();
  if (loadingState === 'idle' || loadingState === 'failed') {
    requestRefresh();
  } else if (loadingState === 'loading' && now - lastRefreshTime > LOADING_TIMEOUT) {
    debugWarn('[OpenCodeSlashCommandProvider] Loading timeout');
    loadingState = 'failed';
    requestRefresh();
  }

  if (loadingState !== 'success') {
    await waitForCommands(signal, LOADING_TIMEOUT).catch(() => {});
  }

  const builtinCommands = await slashCommandProvider(query, signal).catch((error) => {
    debugWarn('[OpenCodeSlashCommandProvider] Failed to load built-in slash commands: ' + String(error));
    return [] as CommandItem[];
  });

  const filteredOpenCodeCommands = loadingState === 'success'
    ? filterCommands(cachedCommands, query)
    : [];

  return mergeOpenCodeSlashCommandGroups(builtinCommands, filteredOpenCodeCommands);
}

/**
 * Warm the opencode-native slash command cache before the user opens `/`.
 */
export function preloadOpenCodeSlashCommands(): void {
  if (loadingState !== 'idle' && loadingState !== 'failed') {
    debugLog('[OpenCodeSlashCommandProvider] Preload skipped (state=' + loadingState + ')');
    return;
  }

  setupOpenCodeSlashCommandsCallback();
  requestRefresh();
}

export default openCodeSlashCommandProvider;
