/**
 * 路径处理工具模块 (CommonJS 版本)
 * 负责路径规范化、用户目录处理
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 缓存真实的用户目录路径，避免重复计算
let cachedRealHomeDir = null;

/**
 * 获取真实的用户目录路径.
 * 解决 Windows 上用户目录被移动或使用符号链接/Junction 的问题。
 * @returns {string} 真实的用户目录路径
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
 * 获取 .codemoss 配置目录路径.
 * @returns {string} ~/.codemoss 目录路径
 */
function getCodemossDir() {
  return path.join(getRealHomeDir(), '.codemoss');
}

/**
 * 获取 .claude 配置目录路径.
 * @returns {string} ~/.claude 目录路径
 */
function getClaudeDir() {
  return path.join(getRealHomeDir(), '.claude');
}

module.exports = {
  getRealHomeDir,
  getCodemossDir,
  getClaudeDir
};
