/**
 * Input history service module
 * Responsible for persistent storage of user input history
 * Storage location: ~/.codemoss/inputHistory.json
 */

const fs = require('fs');
const path = require('path');
const { getCodemossDir } = require('../utils/path-utils.cjs');

const CODEMOSS_DIR = getCodemossDir();
const HISTORY_FILE = path.join(CODEMOSS_DIR, 'inputHistory.json');

/** Maximum number of history items */
const MAX_HISTORY_ITEMS = 200;

/** Maximum number of count records */
const MAX_COUNT_RECORDS = 200;

/**
 * Ensure the directory exists
 */
function ensureDir() {
  if (!fs.existsSync(CODEMOSS_DIR)) {
    fs.mkdirSync(CODEMOSS_DIR, { recursive: true });
  }
}

/**
 * Read the history data file
 * @returns {{ items: string[], counts: Record<string, number> }}
 */
function readHistoryFile() {
  try {
    ensureDir();

    if (!fs.existsSync(HISTORY_FILE)) {
      return { items: [], counts: {} };
    }

    const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
    const parsed = JSON.parse(data);

    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      counts: typeof parsed.counts === 'object' && parsed.counts !== null ? parsed.counts : {}
    };
  } catch (error) {
    console.error('[InputHistory] Failed to read history file:', error.message);
    return { items: [], counts: {} };
  }
}

/**
 * Write the history data file
 * @param {{ items: string[], counts: Record<string, number> }} data
 */
function writeHistoryFile(data) {
  try {
    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('[InputHistory] Failed to write history file:', error.message);
    throw error;
  }
}

/**
 * Load the history item list
 * @returns {string[]}
 */
function loadHistory() {
  const data = readHistoryFile();
  return data.items;
}

/**
 * Load usage counts
 * @returns {Record<string, number>}
 */
function loadCounts() {
  const data = readHistoryFile();
  return data.counts;
}

/**
 * Trim count records and keep the most frequently used entries
 * @param {Record<string, number>} counts
 * @returns {Record<string, number>}
 */
function cleanupCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length <= MAX_COUNT_RECORDS) return counts;

  // Sort by count in descending order and keep the top MAX_COUNT_RECORDS entries
  entries.sort((a, b) => b[1] - a[1]);
  const kept = entries.slice(0, MAX_COUNT_RECORDS);
  return Object.fromEntries(kept);
}

/**
 * Record history, including split fragments
 * @param {string[]} fragments - Array of fragments to record
 * @returns {{ success: boolean, items: string[] }}
 */
function recordHistory(fragments) {
  try {
    if (!Array.isArray(fragments) || fragments.length === 0) {
      return { success: true, items: loadHistory() };
    }

    const data = readHistoryFile();
    let { items, counts } = data;

    // Increment the usage count for each fragment
    for (const fragment of fragments) {
      counts[fragment] = (counts[fragment] || 0) + 1;
    }

    // Trim count records
    counts = cleanupCounts(counts);

    // Create a set of incoming fragments for fast lookups
    const newFragmentsSet = new Set(fragments);

    // Remove existing fragments to avoid duplicates
    const filteredItems = items.filter(item => !newFragmentsSet.has(item));

    // Append new fragments to the end
    const newItems = [...filteredItems, ...fragments].slice(-MAX_HISTORY_ITEMS);

    writeHistoryFile({ items: newItems, counts });

    return { success: true, items: newItems };
  } catch (error) {
    console.error('[InputHistory] Failed to record history:', error.message);
    return { success: false, error: error.message, items: loadHistory() };
  }
}

/**
 * Delete a single history entry
 * @param {string} item - Entry to delete
 * @returns {{ success: boolean, items: string[] }}
 */
function deleteHistoryItem(item) {
  try {
    const data = readHistoryFile();
    let { items, counts } = data;

    // Remove it from the item list
    items = items.filter(i => i !== item);

    // Remove it from the count map
    delete counts[item];

    writeHistoryFile({ items, counts });

    return { success: true, items };
  } catch (error) {
    console.error('[InputHistory] Failed to delete history item:', error.message);
    return { success: false, error: error.message, items: loadHistory() };
  }
}

/**
 * Clear all history entries
 * @returns {{ success: boolean }}
 */
function clearAllHistory() {
  try {
    writeHistoryFile({ items: [], counts: {} });
    return { success: true };
  } catch (error) {
    console.error('[InputHistory] Failed to clear history:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get all history data for the settings page
 * @returns {{ items: string[], counts: Record<string, number> }}
 */
function getAllHistoryData() {
  return readHistoryFile();
}

// Export via CommonJS
module.exports = {
  loadHistory,
  loadCounts,
  recordHistory,
  deleteHistoryItem,
  clearAllHistory,
  getAllHistoryData,
  MAX_HISTORY_ITEMS
};
