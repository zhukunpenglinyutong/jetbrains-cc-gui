/**
 * Path utilities module
 * Handles path normalization, temporary directory detection, and working directory selection
 */

import fs from 'fs';
import { resolve, join } from 'path';
import { homedir, tmpdir } from 'os';

// Cache the resolved home directory path to avoid redundant computation
let cachedRealHomeDir = null;

/**
 * Get the real (physical) home directory path.
 * Resolves issues on Windows where the home directory may have been moved
 * or accessed via symlinks/junctions.
 * Uses fs.realpathSync to obtain the physical path, ensuring consistency
 * with the actual filesystem.
 * @returns {string} The resolved physical home directory path
 */
export function getRealHomeDir() {
  if (cachedRealHomeDir) {
    return cachedRealHomeDir;
  }

  const rawHome = homedir();
  try {
    // Use realpathSync to get the real physical path, resolving symlinks/junctions
    cachedRealHomeDir = fs.realpathSync(rawHome);
  } catch {
    // If realpath fails, fall back to the raw path
    console.warn('[path-utils] Failed to resolve real home path, using raw path:', rawHome);
    cachedRealHomeDir = rawHome;
  }

  return cachedRealHomeDir;
}

/**
 * Get the .codemoss configuration directory path.
 * @returns {string} The ~/.codemoss directory path
 */
export function getCodemossDir() {
  return join(getRealHomeDir(), '.codemoss');
}

/**
 * Get the .claude configuration directory path.
 * @returns {string} The ~/.claude directory path
 */
export function getClaudeDir() {
  return join(getRealHomeDir(), '.claude');
}

/**
 * Get the list of system temporary directory prefixes
 * Supports Windows, macOS, and Linux
 */
export function getTempPathPrefixes() {
  const prefixes = [];

  // 1. Get the system temp directory via os.tmpdir()
  const systemTempDir = tmpdir();
  if (systemTempDir) {
    prefixes.push(normalizePathForComparison(systemTempDir));
  }

  // 2. Windows-specific environment variables
  if (process.platform === 'win32') {
    const winTempVars = ['TEMP', 'TMP', 'LOCALAPPDATA'];
    for (const varName of winTempVars) {
      const value = process.env[varName];
      if (value) {
        prefixes.push(normalizePathForComparison(value));
        // Windows Temp is typically at LOCALAPPDATA\Temp
        if (varName === 'LOCALAPPDATA') {
          prefixes.push(normalizePathForComparison(join(value, 'Temp')));
        }
      }
    }
    // Default Windows temp paths
    prefixes.push('c:\\windows\\temp');
    prefixes.push('c:\\temp');
  } else {
    // Unix/macOS temp path prefixes
    prefixes.push('/tmp');
    prefixes.push('/var/tmp');
    prefixes.push('/private/tmp');

    // Environment variables
    if (process.env.TMPDIR) {
      prefixes.push(normalizePathForComparison(process.env.TMPDIR));
    }
  }

  // Deduplicate
  return [...new Set(prefixes)];
}

/**
 * Normalize a path for comparison purposes.
 * On Windows: converts to lowercase and uses forward slashes.
 */
export function normalizePathForComparison(pathValue) {
  if (!pathValue) return '';
  let normalized = pathValue.replace(/\\/g, '/');
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * Sanitize a path candidate.
 * @param {string} candidate - The candidate path
 * @returns {string|null} The normalized path, or null if invalid
 */
export function sanitizePath(candidate) {
  if (!candidate || typeof candidate !== 'string' || candidate.trim() === '') {
    return null;
  }
  try {
    return resolve(candidate.trim());
  } catch {
    return null;
  }
}

/**
 * Check whether a path is inside a temporary directory.
 * @param {string} pathValue - The path to check
 * @returns {boolean}
 */
export function isTempDirectory(pathValue) {
  if (!pathValue) return false;

  const normalizedPath = normalizePathForComparison(pathValue);
  const tempPrefixes = getTempPathPrefixes();

  return tempPrefixes.some(tempPath => {
    if (!tempPath) return false;
    return normalizedPath.startsWith(tempPath) ||
           normalizedPath === tempPath;
  });
}

/**
 * Intelligently select the working directory.
 * @param {string} requestedCwd - The requested working directory
 * @returns {string} The selected working directory
 */
export function selectWorkingDirectory(requestedCwd) {
  const candidates = [];

  const envProjectPath = process.env.IDEA_PROJECT_PATH || process.env.PROJECT_PATH;

  if (requestedCwd && requestedCwd !== 'undefined' && requestedCwd !== 'null') {
    candidates.push(requestedCwd);
  }
  if (envProjectPath) {
    candidates.push(envProjectPath);
  }

  candidates.push(process.cwd());
  candidates.push(getRealHomeDir());

  console.log('[DEBUG] selectWorkingDirectory candidates:', JSON.stringify(candidates));

  for (const candidate of candidates) {
    const normalized = sanitizePath(candidate);
    if (!normalized) continue;

    if (isTempDirectory(normalized) && envProjectPath) {
      console.log('[DEBUG] Skipping temp directory candidate:', normalized);
      continue;
    }

    try {
      const stats = fs.statSync(normalized);
      if (stats.isDirectory()) {
        console.log('[DEBUG] selectWorkingDirectory resolved:', normalized);
        return normalized;
      }
    } catch {
      // Ignore invalid candidates
      console.log('[DEBUG] Candidate is invalid:', normalized);
    }
  }

  console.log('[DEBUG] selectWorkingDirectory fallback triggered');
  return envProjectPath || getRealHomeDir();
}
