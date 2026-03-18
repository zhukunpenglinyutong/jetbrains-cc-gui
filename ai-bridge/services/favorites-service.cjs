/**
 * Favorites service module
 * Responsible for managing session favorites
 */

const fs = require('fs');
const path = require('path');
const { getCodemossDir } = require('../utils/path-utils.cjs');

const FAVORITES_DIR = getCodemossDir();
const FAVORITES_FILE = path.join(FAVORITES_DIR, 'favorites.json');

/**
 * Ensure the favorites directory exists
 */
function ensureFavoritesDir() {
  if (!fs.existsSync(FAVORITES_DIR)) {
    fs.mkdirSync(FAVORITES_DIR, { recursive: true });
  }
}

/**
 * Load favorites data
 * @returns {Object} Favorites data in the format: { "sessionId": { "favoritedAt": timestamp } }
 */
function loadFavorites() {
  try {
    ensureFavoritesDir();

    if (!fs.existsSync(FAVORITES_FILE)) {
      return {};
    }

    const data = fs.readFileSync(FAVORITES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('[Favorites] Failed to load favorites:', error.message);
    return {};
  }
}

/**
 * Save favorites data
 * @param {Object} favorites - Favorites data
 */
function saveFavorites(favorites) {
  try {
    ensureFavoritesDir();
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify(favorites, null, 2), 'utf-8');
  } catch (error) {
    console.error('[Favorites] Failed to save favorites:', error.message);
    throw error;
  }
}

/**
 * Add a favorite
 * @param {string} sessionId - Session ID
 * @returns {boolean} Whether the operation succeeded
 */
function addFavorite(sessionId) {
  try {
    const favorites = loadFavorites();

    if (favorites[sessionId]) {
      console.log('[Favorites] Session already favorited:', sessionId);
      return true;
    }

    favorites[sessionId] = {
      favoritedAt: Date.now()
    };

    saveFavorites(favorites);
    console.log('[Favorites] Added favorite:', sessionId);
    return true;
  } catch (error) {
    console.error('[Favorites] Failed to add favorite:', error.message);
    return false;
  }
}

/**
 * Remove a favorite
 * @param {string} sessionId - Session ID
 * @returns {boolean} Whether the operation succeeded
 */
function removeFavorite(sessionId) {
  try {
    const favorites = loadFavorites();

    if (!favorites[sessionId]) {
      console.log('[Favorites] Session not favorited:', sessionId);
      return true;
    }

    delete favorites[sessionId];

    saveFavorites(favorites);
    console.log('[Favorites] Removed favorite:', sessionId);
    return true;
  } catch (error) {
    console.error('[Favorites] Failed to remove favorite:', error.message);
    return false;
  }
}

/**
 * Toggle favorite status
 * @param {string} sessionId - Session ID
 * @returns {Object} { success: boolean, isFavorited: boolean }
 */
function toggleFavorite(sessionId) {
  try {
    const favorites = loadFavorites();
    const isFavorited = !!favorites[sessionId];

    if (isFavorited) {
      removeFavorite(sessionId);
    } else {
      addFavorite(sessionId);
    }

    return {
      success: true,
      isFavorited: !isFavorited
    };
  } catch (error) {
    console.error('[Favorites] Failed to toggle favorite:', error.message);
    return {
      success: false,
      isFavorited: false,
      error: error.message
    };
  }
}

/**
 * Check whether a session is favorited
 * @param {string} sessionId - Session ID
 * @returns {boolean}
 */
function isFavorited(sessionId) {
  const favorites = loadFavorites();
  return !!favorites[sessionId];
}

/**
 * Get the favorite timestamp
 * @param {string} sessionId - Session ID
 * @returns {number|null} Favorite timestamp, or null if not favorited
 */
function getFavoritedAt(sessionId) {
  const favorites = loadFavorites();
  return favorites[sessionId]?.favoritedAt || null;
}

/**
 * Get all favorited session IDs in reverse favorite-time order
 * @returns {string[]}
 */
function getFavoritedSessionIds() {
  const favorites = loadFavorites();

  return Object.entries(favorites)
    .sort((a, b) => b[1].favoritedAt - a[1].favoritedAt)
    .map(([sessionId]) => sessionId);
}

// Export via CommonJS
module.exports = {
  loadFavorites,
  addFavorite,
  removeFavorite,
  toggleFavorite,
  isFavorited,
  getFavoritedAt,
  getFavoritedSessionIds,
  ensureFavoritesDir
};
