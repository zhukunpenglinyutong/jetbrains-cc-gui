/**
 * 路径处理工具模块
 * 负责路径规范化、临时目录检测、工作目录选择
 */

import fs from 'fs';
import { resolve, join } from 'path';
import { homedir, tmpdir } from 'os';

// 缓存真实的用户目录路径，避免重复计算
let cachedRealHomeDir = null;

/**
 * 获取真实的用户目录路径.
 * 解决 Windows 上用户目录被移动或使用符号链接/Junction 的问题。
 * 使用 fs.realpathSync 获取物理路径，确保与文件系统实际路径一致。
 * @returns {string} 真实的用户目录路径
 */
export function getRealHomeDir() {
  if (cachedRealHomeDir) {
    return cachedRealHomeDir;
  }

  const rawHome = homedir();
  try {
    // 使用 realpathSync 获取真实的物理路径，解决符号链接/Junction 问题
    cachedRealHomeDir = fs.realpathSync(rawHome);
  } catch {
    // 如果 realpath 失败，回退到原始路径
    console.warn('[path-utils] Failed to resolve real home path, using raw path:', rawHome);
    cachedRealHomeDir = rawHome;
  }

  return cachedRealHomeDir;
}

/**
 * 获取 .codemoss 配置目录路径.
 * @returns {string} ~/.codemoss 目录路径
 */
export function getCodemossDir() {
  return join(getRealHomeDir(), '.codemoss');
}

/**
 * 获取 .claude 配置目录路径.
 * @returns {string} ~/.claude 目录路径
 */
export function getClaudeDir() {
  return join(getRealHomeDir(), '.claude');
}

/**
 * 获取系统临时目录前缀列表
 * 支持 Windows、macOS 和 Linux
 */
export function getTempPathPrefixes() {
  const prefixes = [];

  // 1. 使用 os.tmpdir() 获取系统临时目录
  const systemTempDir = tmpdir();
  if (systemTempDir) {
    prefixes.push(normalizePathForComparison(systemTempDir));
  }

  // 2. Windows 特定环境变量
  if (process.platform === 'win32') {
    const winTempVars = ['TEMP', 'TMP', 'LOCALAPPDATA'];
    for (const varName of winTempVars) {
      const value = process.env[varName];
      if (value) {
        prefixes.push(normalizePathForComparison(value));
        // Windows Temp 通常在 LOCALAPPDATA\Temp
        if (varName === 'LOCALAPPDATA') {
          prefixes.push(normalizePathForComparison(join(value, 'Temp')));
        }
      }
    }
    // Windows 默认临时路径
    prefixes.push('c:\\windows\\temp');
    prefixes.push('c:\\temp');
  } else {
    // Unix/macOS 临时路径前缀
    prefixes.push('/tmp');
    prefixes.push('/var/tmp');
    prefixes.push('/private/tmp');

    // 环境变量
    if (process.env.TMPDIR) {
      prefixes.push(normalizePathForComparison(process.env.TMPDIR));
    }
  }

  // 去重
  return [...new Set(prefixes)];
}

/**
 * 规范化路径用于比较
 * Windows: 转小写，使用正斜杠
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
 * 清理路径
 * @param {string} candidate - 候选路径
 * @returns {string|null} 规范化后的路径或 null
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
 * 检查路径是否为临时目录
 * @param {string} pathValue - 路径
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
 * 智能选择工作目录
 * @param {string} requestedCwd - 请求的工作目录
 * @returns {string} 选定的工作目录
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
