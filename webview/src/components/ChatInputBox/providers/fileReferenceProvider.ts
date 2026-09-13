import type { FileItem, DropdownItemData } from '../types';
import { getFileIcon, getFolderIcon } from '../../../utils/fileIcons';
import { icon_terminal, icon_server } from '../../../utils/icons';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

interface PendingRequest {
  requestId: number;
  searchQuery: string;
  resolve: (files: FileItem[]) => void;
  reject: (error: Error) => void;
}

/** In-flight list_files requests keyed by requestId (supports out-of-order Java replies). */
const pendingById = new Map<number, PendingRequest>();
/** Monotonic id; also used as "latest request" for UI. */
let requestSeq = 0;

/**
 * Reset file reference provider state
 * Called during component initialization to ensure clean state
 */
export function resetFileReferenceState() {
  debugLog('[fileReferenceProvider] Resetting file reference state');
  for (const pending of pendingById.values()) {
    try {
      pending.reject(new DOMException('Aborted', 'AbortError'));
    } catch {
      // ignore
    }
  }
  pendingById.clear();
  // Keep requestSeq increasing so late replies from a previous session stay stale.
}

/**
 * Always (re)bind the Java callback so hot reload / remounts pick up latest logic.
 */
function setupFileListCallback() {
  if (typeof window === 'undefined') {
    return;
  }

  window.onFileListResult = (json: string) => {
    let data: { files?: FileItem[]; requestId?: number | string } | FileItem[];
    try {
      data = JSON.parse(json);
    } catch (error) {
      debugError('[fileReferenceProvider] Parse error:', error);
      // Reject the latest pending request if any — parse errors are rare and global.
      const latest = [...pendingById.values()].pop();
      if (latest) {
        pendingById.delete(latest.requestId);
        latest.reject(error as Error);
      }
      return;
    }

    const responseRequestId = (() => {
      if (Array.isArray(data) || data == null || typeof data !== 'object') {
        return null;
      }
      const raw = (data as { requestId?: number | string }).requestId;
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (typeof raw === 'string' && raw !== '') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
      return null;
    })();

    let pending: PendingRequest | undefined;
    if (responseRequestId != null) {
      pending = pendingById.get(responseRequestId);
      if (!pending) {
        // Late / aborted request — safe to drop.
        debugLog('[fileReferenceProvider] Ignoring response for unknown/aborted requestId', {
          responseRequestId,
          pendingCount: pendingById.size,
        });
        return;
      }
      pendingById.delete(responseRequestId);
    } else {
      // Legacy backend without requestId: deliver to the most recent waiter only.
      let latestId = -1;
      for (const id of pendingById.keys()) {
        if (id > latestId) latestId = id;
      }
      if (latestId < 0) {
        debugLog('[fileReferenceProvider] Ignoring unsolicited file list response');
        return;
      }
      pending = pendingById.get(latestId);
      pendingById.delete(latestId);
    }

    if (!pending) {
      return;
    }

    let files: FileItem[] = Array.isArray(data)
      ? data
      : ((data as { files?: FileItem[] }).files || []);

    files = files.filter(file => !shouldHideFile(file.name));

    // Hard-filter + rank by basename / relative path only.
    // Never fall back to unfiltered backend rows: absolute-path over-matching
    // (e.g. project folder "jetbrains-cc-gui" vs query "b") must not leak into UI.
    // Empty is correct when nothing actually matches the query.
    const searchQuery = pending.searchQuery;
    if (searchQuery) {
      files = filterFiles(files, searchQuery);
    }

    debugLog('[fileReferenceProvider] Delivering file list', {
      requestId: pending.requestId,
      searchQuery,
      count: files.length,
    });
    pending.resolve(files);
  };
}

/**
 * Send request to Java
 */
function sendToJava(event: string, payload: Record<string, unknown>) {
  if (window.sendToJava) {
    window.sendToJava(`${event}:${JSON.stringify(payload)}`);
  } else {
    debugWarn('[fileReferenceProvider] sendToJava not available');
  }
}

/**
 * Check if a file should be hidden (not displayed in the list)
 */
function shouldHideFile(fileName: string): boolean {
  const hiddenItems = [
    '.DS_Store',
    '.git',
    'node_modules',
    '.idea',
  ];

  return hiddenItems.includes(fileName);
}

const DEFAULT_FILES: FileItem[] = [];

/**
 * True when path looks absolute (POSIX, Windows drive, UNC).
 */
export function isAbsoluteLikePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true;
  if (path.startsWith('//') || path.startsWith('\\\\')) return true;
  return false;
}

/**
 * Subsequence fuzzy match (IDE-style): every query char appears in order.
 */
export function fuzzySubsequenceMatch(text: string, query: string): boolean {
  if (!query) return true;
  if (!text) return false;
  let ti = 0;
  let qi = 0;
  while (ti < text.length && qi < query.length) {
    if (text.charAt(ti) === query.charAt(qi)) {
      qi += 1;
    }
    ti += 1;
  }
  return qi === query.length;
}

/**
 * Score a file against a query for ranking (higher is better).
 * Prefer filename prefix/substring over path or pure fuzzy subsequence.
 * Absolute paths never contribute (avoids matching "jetbrains" on query "b").
 */
export function scoreFileMatch(file: FileItem, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const name = (file.name || '').toLowerCase();
  const path = (file.path || '').toLowerCase();
  const pathForMatch = isAbsoluteLikePath(path) ? '' : path;

  if (name === q) return 1000;
  if (name.startsWith(q)) return 900;
  if (name.includes(q)) return 800;
  if (pathForMatch && pathForMatch.includes(q)) return 600;
  if (fuzzySubsequenceMatch(name, q)) return 400;
  if (pathForMatch && fuzzySubsequenceMatch(pathForMatch, q)) return 200;
  return 0;
}

export function fileMatchesQuery(file: FileItem, query: string): boolean {
  if (!query) return true;
  return scoreFileMatch(file, query) > 0;
}

/** Sort by match score without dropping items. */
export function rankFiles(files: FileItem[], query: string): FileItem[] {
  if (!query) return files;
  return [...files].sort((a, b) => {
    const scoreDiff = scoreFileMatch(b, query) - scoreFileMatch(a, query);
    if (scoreDiff !== 0) return scoreDiff;
    const depthA = (a.path || '').split(/[/\\]/).length;
    const depthB = (b.path || '').split(/[/\\]/).length;
    if (depthA !== depthB) return depthA - depthB;
    return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
  });
}

/**
 * Filter and rank files by search keyword (used for local/default lists & tests).
 */
export function filterFiles(files: FileItem[], query: string): FileItem[] {
  let filtered = files.filter(file => !shouldHideFile(file.name));

  if (query) {
    filtered = filtered
      .filter(file => fileMatchesQuery(file, query))
      .sort((a, b) => {
        const scoreDiff = scoreFileMatch(b, query) - scoreFileMatch(a, query);
        if (scoreDiff !== 0) return scoreDiff;
        const depthA = (a.path || '').split(/[/\\]/).length;
        const depthB = (b.path || '').split(/[/\\]/).length;
        if (depthA !== depthB) return depthA - depthB;
        return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
      });
  }

  return filtered;
}

/**
 * Extract current path and search keyword from query string
 */
export function parseQuery(query: string): { currentPath: string; searchQuery: string } {
  if (!query) {
    return { currentPath: '', searchQuery: '' };
  }

  const lastSlashIndex = query.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    return { currentPath: '', searchQuery: query };
  }

  const currentPath = query.substring(0, lastSlashIndex + 1);
  const searchQuery = query.substring(lastSlashIndex + 1);

  return { currentPath, searchQuery };
}

/**
 * File reference data provider
 */
export async function fileReferenceProvider(
  query: string,
  signal: AbortSignal
): Promise<FileItem[]> {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  setupFileListCallback();

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const { currentPath, searchQuery } = parseQuery(query);
    const requestId = ++requestSeq;

    const pending: PendingRequest = {
      requestId,
      searchQuery,
      resolve,
      reject,
    };
    pendingById.set(requestId, pending);

    const cleanup = () => {
      pendingById.delete(requestId);
    };

    signal.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });

    if (!window.sendToJava) {
      cleanup();
      resolve(filterFiles(DEFAULT_FILES, searchQuery));
      return;
    }

    sendToJava('list_files', {
      query: searchQuery,
      currentPath,
      requestId,
    });

    // Timeout: resolve empty rather than hang forever
    setTimeout(() => {
      if (!pendingById.has(requestId)) {
        return;
      }
      pendingById.delete(requestId);
      debugWarn('[fileReferenceProvider] list_files timed out', { requestId, searchQuery });
      resolve(filterFiles(DEFAULT_FILES, searchQuery));
    }, 5000);
  });
}

/**
 * Convert FileItem to DropdownItemData
 */
export function fileToDropdownItem(file: FileItem): DropdownItemData {
  let iconSvg: string;
  let type: 'directory' | 'file' | 'terminal' | 'service';

  if (file.type === 'terminal') {
    iconSvg = icon_terminal;
    type = 'terminal';
  } else if (file.type === 'service') {
    iconSvg = icon_server;
    type = 'service';
  } else if (file.type === 'directory') {
    iconSvg = getFolderIcon(file.name, false);
    type = 'directory';
  } else {
    iconSvg = getFileIcon(file.extension, file.name);
    type = 'file';
  }

  return {
    id: file.path || file.absolutePath || file.name,
    label: file.name,
    description: file.absolutePath || file.path,
    icon: iconSvg,
    type: type,
    data: { file },
  };
}

export default fileReferenceProvider;
