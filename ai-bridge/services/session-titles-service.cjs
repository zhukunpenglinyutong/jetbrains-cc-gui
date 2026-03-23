/**
 * Session title service module
 * Responsible for managing custom session titles
 */

const fs = require('fs');
const path = require('path');
const { getCodemossDir } = require('../utils/path-utils.cjs');

const TITLES_DIR = getCodemossDir();
const TITLES_FILE = path.join(TITLES_DIR, 'session-titles.json');

/**
 * Ensure the title directory exists
 */
function ensureTitlesDir() {
  if (!fs.existsSync(TITLES_DIR)) {
    fs.mkdirSync(TITLES_DIR, { recursive: true });
  }
}

/**
 * Load title data
 * @returns {Object} Title data in the format: { "sessionId": { "customTitle": "Title", "updatedAt": timestamp } }
 */
function loadTitles() {
  try {
    ensureTitlesDir();

    if (!fs.existsSync(TITLES_FILE)) {
      return {};
    }

    const data = fs.readFileSync(TITLES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[SessionTitles] Failed to load titles:', error.message);
    return {};
  }
}

/**
 * Save title data using an atomic write:
 * write to a temporary file first, then rename it to avoid data loss if a write crashes midway.
 * @param {Object} titles - Title data
 */
function saveTitles(titles) {
  try {
    ensureTitlesDir();
    const tmpFile = TITLES_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(titles, null, 2), 'utf-8');
    fs.renameSync(tmpFile, TITLES_FILE);
  } catch (error) {
    console.error('[SessionTitles] Failed to save titles:', error.message);
    throw error;
  }
}

/**
 * Update a session title
 * @param {string} sessionId - Session ID
 * @param {string} customTitle - Custom title
 * @returns {Object} { success: boolean, title: string }
 */
function updateTitle(sessionId, customTitle) {
  try {
    const titles = loadTitles();

    // Validate title length (maximum 50 characters)
    if (customTitle && customTitle.length > 50) {
      return {
        success: false,
        error: 'Title too long (max 50 characters)'
      };
    }

    titles[sessionId] = {
      customTitle: customTitle,
      updatedAt: Date.now()
    };

    saveTitles(titles);
    console.log('[SessionTitles] Updated title for session:', sessionId);
    return {
      success: true,
      title: customTitle
    };
  } catch (error) {
    console.error('[SessionTitles] Failed to update title:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get the session title
 * @param {string} sessionId - Session ID
 * @returns {string|null} Custom title, or null if unset
 */
function getTitle(sessionId) {
  const titles = loadTitles();
  return titles[sessionId]?.customTitle || null;
}

/**
 * Delete a session title
 * @param {string} sessionId - Session ID
 * @returns {boolean} Whether the operation succeeded
 */
function deleteTitle(sessionId) {
  try {
    const titles = loadTitles();

    if (!titles[sessionId]) {
      console.log('[SessionTitles] Session title not found:', sessionId);
      return true;
    }

    delete titles[sessionId];

    saveTitles(titles);
    console.log('[SessionTitles] Deleted title for session:', sessionId);
    return true;
  } catch (error) {
    console.error('[SessionTitles] Failed to delete title:', error.message);
    return false;
  }
}

/**
 * Get the last updated timestamp
 * @param {string} sessionId - Session ID
 * @returns {number|null} Updated timestamp, or null if unset
 */
function getUpdatedAt(sessionId) {
  const titles = loadTitles();
  return titles[sessionId]?.updatedAt || null;
}

// Export via CommonJS
module.exports = {
  loadTitles,
  updateTitle,
  getTitle,
  deleteTitle,
  getUpdatedAt,
  ensureTitlesDir
};
