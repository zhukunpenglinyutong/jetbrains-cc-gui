/**
 * 输入历史记录服务模块
 * 负责管理用户输入历史记录的持久化存储
 * 存储位置: ~/.codemoss/inputHistory.json
 */

const fs = require('fs');
const path = require('path');
const { getCodemossDir } = require('../utils/path-utils.cjs');

const CODEMOSS_DIR = getCodemossDir();
const HISTORY_FILE = path.join(CODEMOSS_DIR, 'inputHistory.json');

/** 最大历史记录条数 */
const MAX_HISTORY_ITEMS = 200;

/** 最大计数记录条数 */
const MAX_COUNT_RECORDS = 200;

/**
 * 确保目录存在
 */
function ensureDir() {
  if (!fs.existsSync(CODEMOSS_DIR)) {
    fs.mkdirSync(CODEMOSS_DIR, { recursive: true });
  }
}

/**
 * 读取历史数据文件
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
 * 写入历史数据文件
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
 * 加载历史记录列表
 * @returns {string[]}
 */
function loadHistory() {
  const data = readHistoryFile();
  return data.items;
}

/**
 * 加载使用计数
 * @returns {Record<string, number>}
 */
function loadCounts() {
  const data = readHistoryFile();
  return data.counts;
}

/**
 * 清理计数记录，保留使用频率最高的
 * @param {Record<string, number>} counts
 * @returns {Record<string, number>}
 */
function cleanupCounts(counts) {
  const entries = Object.entries(counts);
  if (entries.length <= MAX_COUNT_RECORDS) return counts;

  // 按计数降序排序，保留前 MAX_COUNT_RECORDS 条
  entries.sort((a, b) => b[1] - a[1]);
  const kept = entries.slice(0, MAX_COUNT_RECORDS);
  return Object.fromEntries(kept);
}

/**
 * 记录历史（包括拆分片段）
 * @param {string[]} fragments - 要记录的片段数组
 * @returns {{ success: boolean, items: string[] }}
 */
function recordHistory(fragments) {
  try {
    if (!Array.isArray(fragments) || fragments.length === 0) {
      return { success: true, items: loadHistory() };
    }

    const data = readHistoryFile();
    let { items, counts } = data;

    // 增加每个片段的使用计数
    for (const fragment of fragments) {
      counts[fragment] = (counts[fragment] || 0) + 1;
    }

    // 清理计数
    counts = cleanupCounts(counts);

    // 创建新片段集合用于快速查找
    const newFragmentsSet = new Set(fragments);

    // 移除已存在的片段以避免重复
    const filteredItems = items.filter(item => !newFragmentsSet.has(item));

    // 添加新片段到末尾
    const newItems = [...filteredItems, ...fragments].slice(-MAX_HISTORY_ITEMS);

    writeHistoryFile({ items: newItems, counts });

    return { success: true, items: newItems };
  } catch (error) {
    console.error('[InputHistory] Failed to record history:', error.message);
    return { success: false, error: error.message, items: loadHistory() };
  }
}

/**
 * 删除单条历史记录
 * @param {string} item - 要删除的记录
 * @returns {{ success: boolean, items: string[] }}
 */
function deleteHistoryItem(item) {
  try {
    const data = readHistoryFile();
    let { items, counts } = data;

    // 从列表中移除
    items = items.filter(i => i !== item);

    // 从计数中移除
    delete counts[item];

    writeHistoryFile({ items, counts });

    return { success: true, items };
  } catch (error) {
    console.error('[InputHistory] Failed to delete history item:', error.message);
    return { success: false, error: error.message, items: loadHistory() };
  }
}

/**
 * 清空所有历史记录
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
 * 获取所有历史数据（用于设置页面展示）
 * @returns {{ items: string[], counts: Record<string, number> }}
 */
function getAllHistoryData() {
  return readHistoryFile();
}

// 使用 CommonJS 导出
module.exports = {
  loadHistory,
  loadCounts,
  recordHistory,
  deleteHistoryItem,
  clearAllHistory,
  getAllHistoryData,
  MAX_HISTORY_ITEMS
};
