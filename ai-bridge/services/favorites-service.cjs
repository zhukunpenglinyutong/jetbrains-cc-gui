/**
 * 收藏服务模块
 * 负责管理会话收藏功能
 */

const fs = require('fs');
const path = require('path');
const { getCodemossDir } = require('../utils/path-utils.cjs');

const FAVORITES_DIR = getCodemossDir();
const FAVORITES_FILE = path.join(FAVORITES_DIR, 'favorites.json');

/**
 * 确保收藏目录存在
 */
function ensureFavoritesDir() {
  if (!fs.existsSync(FAVORITES_DIR)) {
    fs.mkdirSync(FAVORITES_DIR, { recursive: true });
  }
}

/**
 * 加载收藏数据
 * @returns {Object} 收藏数据，格式: { "sessionId": { "favoritedAt": timestamp } }
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
 * 保存收藏数据
 * @param {Object} favorites - 收藏数据
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
 * 添加收藏
 * @param {string} sessionId - 会话ID
 * @returns {boolean} 是否成功
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
 * 移除收藏
 * @param {string} sessionId - 会话ID
 * @returns {boolean} 是否成功
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
 * 切换收藏状态
 * @param {string} sessionId - 会话ID
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
 * 检查会话是否已收藏
 * @param {string} sessionId - 会话ID
 * @returns {boolean}
 */
function isFavorited(sessionId) {
  const favorites = loadFavorites();
  return !!favorites[sessionId];
}

/**
 * 获取收藏时间
 * @param {string} sessionId - 会话ID
 * @returns {number|null} 收藏时间戳，未收藏返回 null
 */
function getFavoritedAt(sessionId) {
  const favorites = loadFavorites();
  return favorites[sessionId]?.favoritedAt || null;
}

/**
 * 获取所有收藏的会话ID列表（按收藏时间倒序）
 * @returns {string[]}
 */
function getFavoritedSessionIds() {
  const favorites = loadFavorites();

  return Object.entries(favorites)
    .sort((a, b) => b[1].favoritedAt - a[1].favoritedAt)
    .map(([sessionId]) => sessionId);
}

// 使用 CommonJS 导出
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
