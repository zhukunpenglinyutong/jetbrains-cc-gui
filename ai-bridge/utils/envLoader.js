/**
 * .env file loader utility.
 * Parses KEY=VALUE format, skipping comments (#) and blank lines.
 * Supports quoted values ("..." or '...').
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

/**
 * Load a .env file and return a key-value map of environment variables.
 * @param {string} filePath - Absolute path to the .env file
 * @returns {object} Map of env variable names to their values
 */
export function loadEnvFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    console.error('[DEBUG] envLoader.loadEnvFile: filePath is null/empty');
    return {};
  }
  if (!existsSync(filePath)) {
    console.error('[DEBUG] envLoader.loadEnvFile: file does not exist at path: ' + filePath);
    return {};
  }
  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = parseEnvContent(content);
    console.error('[DEBUG] envLoader.loadEnvFile: loaded ' + Object.keys(parsed).length + ' vars from ' + filePath);
    console.error('[DEBUG] envLoader.loadEnvFile: keys=' + JSON.stringify(Object.keys(parsed)));
    return parsed;
  } catch (e) {
    console.error('[DEBUG] envLoader.loadEnvFile: error reading file: ' + e.message);
    return {};
  }
}

/**
 * Parse .env content string into a key-value map.
 * Handles comments (#), blank lines, quoted values, and exports.
 * @param {string} content - Raw .env file content
 * @returns {object} Parsed environment variables
 */
export function parseEnvContent(content) {
  const result = {};
  if (!content || typeof content !== 'string') {
    return result;
  }
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) {
      continue;
    }
    const eqIdx = trimmedLine.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    let key = trimmedLine.substring(0, eqIdx).trim();
    let value = trimmedLine.substring(eqIdx + 1).trim();
    key = key.replace(/^export\s+/, '').trim();
    if (key === '') {
      continue;
    }
    if (key.startsWith('#')) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
