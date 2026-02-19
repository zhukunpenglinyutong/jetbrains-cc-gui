import type { FileItem, DropdownItemData } from '../types';
import { getFileIcon, getFolderIcon } from '../../../utils/fileIcons';
import { icon_terminal, icon_server } from '../../../utils/icons';
import { debugError, debugLog, debugWarn } from '../../../utils/debug.js';

// Request queue management
let pendingResolve: ((files: FileItem[]) => void) | null = null;
let pendingReject: ((error: Error) => void) | null = null;
let lastQuery: string = '';

/**
 * Reset file reference provider state
 * Called during component initialization to ensure clean state
 */
export function resetFileReferenceState() {
  debugLog('[fileReferenceProvider] Resetting file reference state');
  pendingResolve = null;
  pendingReject = null;
  lastQuery = '';
}

/**
 * Register Java callback
 */
function setupFileListCallback() {
  if (typeof window !== 'undefined' && !window.onFileListResult) {
    window.onFileListResult = (json: string) => {
      try {
        const data = JSON.parse(json);
        let files: FileItem[] = data.files || data || [];

        // Filter out files that should be hidden
        files = files.filter(file => !shouldHideFile(file.name));

        const result = files.length > 0 ? files : filterFiles(DEFAULT_FILES, lastQuery);
        pendingResolve?.(result);
      } catch (error) {
        debugError('[fileReferenceProvider] Parse error:', error);
        pendingReject?.(error as Error);
      } finally {
        pendingResolve = null;
        pendingReject = null;
      }
    };
  }
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
  // Hidden files/folders list
  const hiddenItems = [
    '.DS_Store',      // macOS system file
    '.git',           // Git repository folder
    'node_modules',   // npm dependency folder
    '.idea',          // IntelliJ IDEA configuration folder
  ];

  return hiddenItems.includes(fileName);
}

/**
 * Default file list (returns empty list when Java side is not implemented)
 */
const DEFAULT_FILES: FileItem[] = [];

/**
 * Filter files
 */
function filterFiles(files: FileItem[], query: string): FileItem[] {
  // First filter out files that should be hidden
  let filtered = files.filter(file => !shouldHideFile(file.name));

  // If there's a search keyword, filter by keyword as well
  if (query) {
    const lowerQuery = query.toLowerCase();
    filtered = filtered.filter(file =>
      file.name.toLowerCase().includes(lowerQuery) ||
      file.path.toLowerCase().includes(lowerQuery)
    );
  }

  return filtered;
}

/**
 * Extract current path and search keyword from query string
 * Examples:
 *   "" → { currentPath: "", searchQuery: "" }
 *   "src/" → { currentPath: "src/", searchQuery: "" }
 *   "src/com" → { currentPath: "src/", searchQuery: "com" }
 *   "but" → { currentPath: "", searchQuery: "but" }
 */
function parseQuery(query: string): { currentPath: string; searchQuery: string } {
  if (!query) {
    return { currentPath: '', searchQuery: '' };
  }

  // Check if the query contains a / character
  const lastSlashIndex = query.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    // No slash means searching in root directory
    return { currentPath: '', searchQuery: query };
  }

  // Has slash, separate path and search term
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
  // Check if aborted
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  // Set up callback
  setupFileListCallback();

  return new Promise((resolve, reject) => {
    // Check if aborted
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    // Parse query: separate path and search keyword
    const { currentPath, searchQuery } = parseQuery(query);

    // Save callbacks
    pendingResolve = resolve;
    pendingReject = reject;
    lastQuery = query;

    // Listen for abort signal
    signal.addEventListener('abort', () => {
      pendingResolve = null;
      pendingReject = null;
      reject(new DOMException('Aborted', 'AbortError'));
    });

    // Check if sendToJava is available
    if (!window.sendToJava) {
      // Use default file list for local filtering
      const filtered = filterFiles(DEFAULT_FILES, searchQuery);
      pendingResolve = null;
      pendingReject = null;
      resolve(filtered);
      return;
    }

    // Send request with current path and search keyword
    sendToJava('list_files', {
      query: searchQuery,        // Search keyword
      currentPath: currentPath,  // Current path
    });

    // Timeout handling (3 seconds), fall back to default file list on timeout
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        pendingReject = null;
        // Return filtered default file list on timeout
        resolve(filterFiles(DEFAULT_FILES, searchQuery));
      }
    }, 3000);
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
    id: file.path,
    label: file.name,
    description: file.absolutePath || file.path, // Prefer full path
    icon: iconSvg, // Use SVG string directly
    type: type,
    data: { file },
  };
}

export default fileReferenceProvider;
