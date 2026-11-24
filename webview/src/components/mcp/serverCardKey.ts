/**
 * Server card identity.
 *
 * When a project-local .mcp.json server collides with an already-merged server, the
 * backend keeps BOTH records and leaves `id` untouched on each: the shadowed one keeps
 * its own id, the project-local one is flagged `conflicting` and parked under a
 * synthetic map key. `id` cannot be renamed — approve/reject/tools/toggle all send
 * `{ serverId: server.id }` — so two cards can carry the same `id`.
 *
 * Therefore:
 *   - `server.id` is the BACKEND identity. It is what goes on the wire, and nothing else.
 *   - `getServerCardKey(server)` is the UI identity. Every piece of per-card state —
 *     the React key, `expandedServers`, `serverTools`, the persisted "last expanded"
 *     pointer, and the lookup that finds a card's server — is addressed by it, so two
 *     colliding cards never share an expansion or a loaded tool list.
 *
 * The key is derived from the on-disk configuration only (`id` + which config file the
 * record came from). It deliberately excludes approvalStatus, trustVerified, enabled,
 * connection status and tools: including any of those would remount the card as soon as
 * it was approved, toggled or polled, throwing away its expanded state.
 */

import type { McpServer } from '../../types/mcp';
import type { ServerToolsState } from './types';

/** Separates the config key from the scope in a card key. */
export const SERVER_CARD_KEY_SEPARATOR = '::';

const GLOBAL_SCOPE = 'global';
const PROJECT_SCOPE = 'project';

export type ServerCardScope = typeof GLOBAL_SCOPE | typeof PROJECT_SCOPE;

/**
 * Which config file a card's record came from.
 *
 * A colliding project-local record is always `project` (that is what `conflicting`
 * means), and anything else follows the backend-reported `source`. Normalising the value
 * keeps the key space closed to `<id>::global` / `<id>::project`, which is what makes a
 * stored key recognizable as a card key and not as a bare server id.
 */
export function getServerCardScope(server: McpServer): ServerCardScope {
  if (server.conflicting) return PROJECT_SCOPE;
  return server.source === PROJECT_SCOPE ? PROJECT_SCOPE : GLOBAL_SCOPE;
}

/** Stable UI identity of a server card: `<id>::<scope>`. */
export function getServerCardKey(server: McpServer): string {
  return `${server.id}${SERVER_CARD_KEY_SEPARATOR}${getServerCardScope(server)}`;
}

// ============================================================================
// Card index
// ============================================================================

export interface ServerCardIndex {
  /** Every card key currently in the list. */
  readonly cardKeys: ReadonlySet<string>;
  readonly serverByCardKey: ReadonlyMap<string, McpServer>;
  /** Raw server id -> the card keys carrying that id (more than one only on a collision). */
  readonly cardKeysByServerId: ReadonlyMap<string, readonly string[]>;
  findServer(cardKey: string): McpServer | undefined;
  /** The single card key for this server id, or null when unknown or ambiguous. */
  findCardKey(serverId: string): string | null;
  /** True when exactly one card carries this server id (i.e. no collision). */
  hasUniqueServerId(serverId: string): boolean;
  forEachCardKeyByServerId(visit: (serverId: string, cardKeys: readonly string[]) => void): void;
}

export const EMPTY_SERVER_CARD_INDEX: ServerCardIndex = {
  cardKeys: new Set<string>(),
  serverByCardKey: new Map<string, McpServer>(),
  cardKeysByServerId: new Map<string, readonly string[]>(),
  findServer: () => undefined,
  findCardKey: () => null,
  hasUniqueServerId: () => false,
  forEachCardKeyByServerId: () => undefined,
};

/**
 * Index the current server list by card key.
 *
 * Rebuilt whenever the list changes; everything that has to translate between the backend
 * identity (`id`) and the UI identity (card key) reads it from here, so no caller has to
 * re-derive the key on its own.
 */
export function buildServerCardIndex(servers: McpServer[]): ServerCardIndex {
  const cardKeys = new Set<string>();
  const serverByCardKey = new Map<string, McpServer>();
  const cardKeysByServerId = new Map<string, string[]>();

  for (const server of servers) {
    const cardKey = getServerCardKey(server);
    if (cardKeys.has(cardKey)) {
      // A duplicate (id, scope) pair would mean the backend handed us two records for the
      // same config entry. Keep the first so every card key stays unique — the UI cannot
      // disambiguate what it was not told apart.
      console.warn('[MCP] Duplicate server card key, ignoring the extra record:', cardKey);
      continue;
    }
    cardKeys.add(cardKey);
    serverByCardKey.set(cardKey, server);
    const existing = cardKeysByServerId.get(server.id);
    if (existing) {
      existing.push(cardKey);
    } else {
      cardKeysByServerId.set(server.id, [cardKey]);
    }
  }

  return {
    cardKeys,
    serverByCardKey,
    cardKeysByServerId,
    findServer: (cardKey) => serverByCardKey.get(cardKey),
    findCardKey: (serverId) => {
      const keys = cardKeysByServerId.get(serverId);
      return keys && keys.length === 1 ? keys[0] : null;
    },
    hasUniqueServerId: (serverId) => cardKeysByServerId.get(serverId)?.length === 1,
    forEachCardKeyByServerId: (visit) => {
      cardKeysByServerId.forEach((cardKeysForId, serverId) => visit(serverId, cardKeysForId));
    },
  };
}

// ============================================================================
// Translating bridge writes into card-keyed state
// ============================================================================

/**
 * Apply a `setServerTools` update so the resulting state is keyed by card keys only.
 *
 * The bridge callbacks that write this state (`updateMcpServerTools` in useToolsUpdate,
 * the invalidations in useServerManagement) only know the backend `serverId`, so their
 * updater functions are run against a copy that answers to raw ids as well; the result is
 * then re-keyed onto the card the raw id belongs to. `claimResponseSlot` settles the one
 * case a raw id cannot answer on its own — a response for a colliding id — by handing
 * back the card key that is waiting for that response, or null to drop the write.
 */
export function applyServerToolsUpdate(
  prev: ServerToolsState,
  value: React.SetStateAction<ServerToolsState>,
  index: ServerCardIndex,
  claimResponseSlot?: (serverId: string) => string | null,
): ServerToolsState {
  // Aliases: raw id -> the card key it mirrors right now. Only created when a card
  // actually holds a result, so that `delete next[serverId]` in an invalidating updater
  // reaches something and `prev[serverId]?.tools` still reads the current list.
  const work: ServerToolsState = { ...prev };
  const aliases = new Map<string, { value: ServerToolsState[string]; cardKeys: readonly string[] }>();
  index.forEachCardKeyByServerId((serverId, cardKeys) => {
    if (serverId in work) return;
    const holder = cardKeys.find((cardKey) => work[cardKey] !== undefined);
    if (holder === undefined) return;
    work[serverId] = work[holder];
    aliases.set(serverId, { value: work[serverId], cardKeys });
  });

  const produced = typeof value === 'function' ? value(work) : value;

  const next: ServerToolsState = {};
  for (const [key, entry] of Object.entries(produced)) {
    if (index.cardKeys.has(key)) {
      next[key] = entry;
      continue;
    }
    // An alias the updater never touched is already carried over under its own card key.
    if (aliases.get(key)?.value === entry) continue;
    const cardKey = index.findCardKey(key) ?? claimResponseSlot?.(key) ?? null;
    if (cardKey) {
      next[cardKey] = entry;
    } else {
      // Neither a live card nor a pending request: the record is gone, or its id is
      // ambiguous with no request in flight. Parking it under the raw id would create a
      // slot no card ever reads, so drop it instead.
      console.warn('[MCP] Dropping tools update for an unresolvable server id:', key);
    }
  }

  // An alias the updater deleted invalidates every card sharing that id.
  for (const [serverId, alias] of aliases) {
    if (serverId in produced) continue;
    alias.cardKeys.forEach((cardKey) => {
      delete next[cardKey];
    });
  }

  return next;
}

/**
 * Resolve a persisted "last expanded server" value to a card key.
 *
 * Values written by the current code are card keys. Values written before that (a bare
 * server id) are accepted only when exactly one card carries that id; an ambiguous legacy
 * value resolves to null and simply restores nothing — an unresolvable pointer is
 * ignored, never guessed at.
 */
export function resolvePersistedCardKey(stored: string | null, index: ServerCardIndex): string | null {
  if (!stored) return null;
  if (index.cardKeys.has(stored)) return stored;
  return index.findCardKey(stored);
}
