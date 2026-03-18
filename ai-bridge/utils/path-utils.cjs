/**
 * Path utility module (CommonJS version)
 * Responsible for path normalization and home directory handling
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Cache the resolved home directory path to avoid repeated lookups
let cachedRealHomeDir = null;

/**
 * Get the resolved home directory path.
 * Handles cases on Windows where the user directory is moved or uses a symlink/junction.
 * @returns {string} Resolved home directory path
 */
function getRealHomeDir() {
  if (cachedRealHomeDir) {
    return cachedRealHomeDir;
  }

  const rawHome = os.homedir();
  try {
    cachedRealHomeDir = fs.realpathSync(rawHome);
  } catch {
    console.warn('[path-utils] Failed to resolve real home path, using raw path:', rawHome);
    cachedRealHomeDir = rawHome;
  }

  return cachedRealHomeDir;
}

/**
 * Get the .codemoss configuration directory path.
 * @returns {string} ~/.codemoss directory path
 */
function getCodemossDir() {
  return path.join(getRealHomeDir(), '.codemoss');
}

/**
 * Get the .claude configuration directory path.
 * @returns {string} ~/.claude directory path
 */
function getClaudeDir() {
  return path.join(getRealHomeDir(), '.claude');
}

module.exports = {
  getRealHomeDir,
  getCodemossDir,
  getClaudeDir
};
