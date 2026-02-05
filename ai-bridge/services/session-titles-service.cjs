/**
 * 会话标题服务模块
 * 负责管理会话自定义标题功能
 */

const fs = require('fs');
const path = require('path');
const { getCodemossDir } = require('../utils/path-utils.cjs');

const TITLES_DIR = getCodemossDir();
const TITLES_FILE = path.join(TITLES_DIR, 'session-titles.json');

/**
 * 确保标题目录存在
 */
function ensureTitlesDir() {
  if (!fs.existsSync(TITLES_DIR)) {
    fs.mkdirSync(TITLES_DIR, { recursive: true });
  }
}

/**
 * 加载标题数据
 * @returns {Object} 标题数据，格式: { "sessionId": { "customTitle": "标题", "updatedAt": timestamp } }
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
 * 保存标题数据
 * @param {Object} titles - 标题数据
 */
function saveTitles(titles) {
  try {
    ensureTitlesDir();
    fs.writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2), 'utf-8');
  } catch (error) {
    console.error('[SessionTitles] Failed to save titles:', error.message);
    throw error;
  }
}

/**
 * 更新会话标题
 * @param {string} sessionId - 会话ID
 * @param {string} customTitle - 自定义标题
 * @returns {Object} { success: boolean, title: string }
 */
function updateTitle(sessionId, customTitle) {
  try {
    const titles = loadTitles();

    // 验证标题长度（最多50个字符）
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
 * 获取会话标题
 * @param {string} sessionId - 会话ID
 * @returns {string|null} 自定义标题，未设置返回 null
 */
function getTitle(sessionId) {
  const titles = loadTitles();
  return titles[sessionId]?.customTitle || null;
}

/**
 * 删除会话标题
 * @param {string} sessionId - 会话ID
 * @returns {boolean} 是否成功
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
 * 获取更新时间
 * @param {string} sessionId - 会话ID
 * @returns {number|null} 更新时间戳，未设置返回 null
 */
function getUpdatedAt(sessionId) {
  const titles = loadTitles();
  return titles[sessionId]?.updatedAt || null;
}

// 使用 CommonJS 导出
module.exports = {
  loadTitles,
  updateTitle,
  getTitle,
  deleteTitle,
  getUpdatedAt,
  ensureTitlesDir
};
