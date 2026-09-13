/**
 * Registry of which sessions/agents recently touched a file.
 * Used so StatusPanel can mark "multi-agent" when AI1 + AI2 (or main + subagent)
 * both edited the same path — even across chat tabs.
 *
 * Stored in localStorage (no full file content — only path + actor keys).
 * The webview has no reliable per-project identifier at this layer, so the
 * registry is global; to stop stale cross-project / ancient history from
 * permanently flipping Write status A→M or lighting multi-agent badges,
 * entries expire after ENTRY_TTL_MS and are lazily pruned on read.
 */

export interface FileTouchActor {
  /** Chat session / tab id */
  sessionId: string;
  /** main | Agent/Task tool id | subagent id */
  agentId: string;
  updatedAt: number;
}

export type FileTouchMap = Record<string, FileTouchActor[]>;

const STORAGE_KEY = 'ccgui-file-touch-registry-v1';
const MAX_ACTORS_PER_FILE = 12;
const MAX_FILES = 400;
/** Entries older than this are stale and lazily dropped on read. */
const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

function actorKey(a: Pick<FileTouchActor, 'sessionId' | 'agentId'>): string {
  return `${a.sessionId}::${a.agentId || 'main'}`;
}

/** Drop expired / malformed actors; reports whether anything was removed. */
function pruneExpired(map: FileTouchMap, now: number): { pruned: FileTouchMap; changed: boolean } {
  let changed = false;
  const pruned: FileTouchMap = {};
  for (const [path, actors] of Object.entries(map)) {
    if (!Array.isArray(actors)) {
      changed = true;
      continue;
    }
    const fresh = actors.filter(
      (a) => a && typeof a.updatedAt === 'number' && now - a.updatedAt <= ENTRY_TTL_MS,
    );
    if (fresh.length !== actors.length) changed = true;
    if (fresh.length > 0) {
      pruned[path] = fresh;
    }
  }
  return { pruned, changed };
}

export function loadFileTouchMap(now = Date.now()): FileTouchMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as FileTouchMap;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const { pruned, changed } = pruneExpired(parsed, now);
    // Lazy cleanup so stale entries don't accumulate in storage
    if (changed) saveFileTouchMap(pruned);
    return pruned;
  } catch {
    return {};
  }
}

export function saveFileTouchMap(map: FileTouchMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // quota / private mode
  }
}

/**
 * Record that this session/agent successfully edited path.
 * Returns the updated actor list for that path.
 */
export function recordFileTouches(
  paths: string[],
  sessionId: string,
  agentIdsByPath: Map<string, string[]>,
  now = Date.now(),
): FileTouchMap {
  if (!sessionId || paths.length === 0) {
    return loadFileTouchMap();
  }

  const map = loadFileTouchMap();

  for (const filePath of paths) {
    if (!filePath) continue;
    const agents = agentIdsByPath.get(filePath) ?? ['main'];
    let list = [...(map[filePath] ?? [])];

    for (const agentId of agents) {
      const key = actorKey({ sessionId, agentId });
      list = list.filter((a) => actorKey(a) !== key);
      list.push({ sessionId, agentId: agentId || 'main', updatedAt: now });
    }

    // Keep newest actors
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    map[filePath] = list.slice(0, MAX_ACTORS_PER_FILE);
  }

  // Cap total files (drop oldest by max updatedAt)
  const entries = Object.entries(map);
  if (entries.length > MAX_FILES) {
    entries.sort((a, b) => {
      const aMax = Math.max(0, ...a[1].map((x) => x.updatedAt));
      const bMax = Math.max(0, ...b[1].map((x) => x.updatedAt));
      return bMax - aMax;
    });
    const next: FileTouchMap = {};
    for (const [p, actors] of entries.slice(0, MAX_FILES)) {
      next[p] = actors;
    }
    saveFileTouchMap(next);
    return next;
  }

  saveFileTouchMap(map);
  return map;
}

/**
 * Distinct actors (session+agent) that touched this file.
 */
export function getDistinctActorsForPath(filePath: string, map?: FileTouchMap): FileTouchActor[] {
  const source = map ?? loadFileTouchMap();
  const list = source[filePath] ?? [];
  const seen = new Set<string>();
  const out: FileTouchActor[] = [];
  for (const a of list) {
    const k = actorKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/**
 * True when ≥2 distinct sessions OR ≥2 distinct agent keys touched the file.
 * (AI1 tab + AI2 tab, or main + subagent, or two Task agents.)
 */
export function isMultiActorPath(filePath: string, map?: FileTouchMap): boolean {
  const actors = getDistinctActorsForPath(filePath, map);
  if (actors.length < 2) return false;
  const sessions = new Set(actors.map((a) => a.sessionId));
  if (sessions.size >= 2) return true;
  const agents = new Set(actors.map((a) => a.agentId || 'main'));
  return agents.size >= 2;
}

/**
 * File was already touched by someone else before this session's first edit.
 * Used to show status M (modified) instead of A when Write overwrites an existing file.
 */
export function wasTouchedOutsideSession(
  filePath: string,
  sessionId: string,
  map?: FileTouchMap,
): boolean {
  if (!sessionId) return false;
  const actors = getDistinctActorsForPath(filePath, map);
  return actors.some((a) => a.sessionId !== sessionId);
}

export function clearFileTouchRegistry(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
