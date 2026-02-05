/**
 * MCP 配置加载模块
 * 提供从 ~/.claude.json 读取 MCP 服务器配置的功能
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getRealHomeDir } from '../../../utils/path-utils.js';
import { log } from './logger.js';

/**
 * 验证 MCP 服务器配置的基本结构
 * @param {Object} serverConfig - 服务器配置对象
 * @returns {boolean} 配置是否有效
 */
function isValidServerConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') {
    return false;
  }
  // 必须有 command (stdio) 或 url (http)
  const hasCommand = typeof serverConfig.command === 'string' && serverConfig.command.length > 0;
  const hasUrl = typeof serverConfig.url === 'string' && serverConfig.url.length > 0;
  if (!hasCommand && !hasUrl) {
    return false;
  }
  // args 如果存在必须是数组
  if (serverConfig.args !== undefined && !Array.isArray(serverConfig.args)) {
    return false;
  }
  // env 如果存在必须是对象
  if (serverConfig.env !== undefined && (typeof serverConfig.env !== 'object' || serverConfig.env === null)) {
    return false;
  }
  return true;
}

/**
 * 验证配置文件的基本结构
 * @param {Object} config - 配置对象
 * @returns {{valid: boolean, reason?: string}} 验证结果
 */
function validateConfigStructure(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, reason: 'Config must be an object' };
  }
  // mcpServers 如果存在必须是对象
  if (config.mcpServers !== undefined) {
    if (typeof config.mcpServers !== 'object' || config.mcpServers === null) {
      return { valid: false, reason: 'mcpServers must be an object' };
    }
    // 验证每个服务器配置
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (!isValidServerConfig(serverConfig)) {
        log('warn', `Invalid server config for "${name}", skipping`);
      }
    }
  }
  // disabledMcpServers 如果存在必须是数组
  if (config.disabledMcpServers !== undefined && !Array.isArray(config.disabledMcpServers)) {
    return { valid: false, reason: 'disabledMcpServers must be an array' };
  }
  // projects 如果存在必须是对象
  if (config.projects !== undefined && (typeof config.projects !== 'object' || config.projects === null)) {
    return { valid: false, reason: 'projects must be an object' };
  }
  return { valid: true };
}

/**
 * 解析 MCP 配置文件中的服务器列表和禁用列表
 * 抽离出公共逻辑，供 loadMcpServersConfig 和 loadAllMcpServersInfo 共享
 * @param {string} cwd - 当前工作目录（用于检测项目）
 * @returns {Promise<{mcpServers: Object, disabledServers: Set<string>} | null>} 解析结果，失败返回 null
 */
async function parseMcpConfig(cwd = null) {
  const claudeJsonPath = join(getRealHomeDir(), '.claude.json');

  if (!existsSync(claudeJsonPath)) {
    log('info', '~/.claude.json not found');
    return null;
  }

  const content = await readFile(claudeJsonPath, 'utf8');
  const config = JSON.parse(content);

  // 验证配置结构
  const validation = validateConfigStructure(config);
  if (!validation.valid) {
    log('error', 'Invalid config structure:', validation.reason);
    return null;
  }

  // 规范化路径以匹配配置中的路径格式
  let normalizedCwd = cwd;
  if (cwd) {
    normalizedCwd = cwd.replace(/\\/g, '/');
    normalizedCwd = normalizedCwd.replace(/\/$/, '');
  }

  // 查找匹配的项目配置
  let projectConfig = null;
  if (normalizedCwd && config.projects) {
    if (config.projects[normalizedCwd]) {
      projectConfig = config.projects[normalizedCwd];
    } else {
      const cwdVariants = [
        normalizedCwd,
        normalizedCwd.replace(/\//g, '\\'),
        '/' + normalizedCwd,
      ];

      for (const projectPath of Object.keys(config.projects)) {
        const normalizedProjectPath = projectPath.replace(/\\/g, '/');
        if (cwdVariants.includes(normalizedProjectPath)) {
          projectConfig = config.projects[projectPath];
          log('info', 'Found project config for:', projectPath);
          break;
        }
      }
    }
  }

  let mcpServers = {};
  let disabledServers = new Set();

  if (projectConfig) {
    log('info', '[MCP Config] Using project-specific MCP configuration');

    if (Object.keys(projectConfig.mcpServers || {}).length > 0) {
      mcpServers = projectConfig.mcpServers;
      disabledServers = new Set(projectConfig.disabledMcpServers || []);
    } else {
      log('info', '[MCP Config] Project has no MCP servers, using global config');
      mcpServers = config.mcpServers || {};

      const globalDisabled = config.disabledMcpServers || [];
      const projectDisabled = projectConfig.disabledMcpServers || [];
      disabledServers = new Set([...globalDisabled, ...projectDisabled]);
    }
  } else {
    log('info', '[MCP Config] Using global MCP configuration');
    mcpServers = config.mcpServers || {};
    disabledServers = new Set(config.disabledMcpServers || []);
  }

  return { mcpServers, disabledServers };
}

/**
 * 从 ~/.claude.json 读取 MCP 服务器配置
 * 支持两种模式：
 * 1. 全局配置 - 使用全局 mcpServers
 * 2. 项目配置 - 使用项目特定的 mcpServers
 * @param {string} cwd - 当前工作目录（用于检测项目）
 * @returns {Promise<Array<{name: string, config: Object}>>} 启用的 MCP 服务器列表
 */
export async function loadMcpServersConfig(cwd = null) {
  try {
    const parsed = await parseMcpConfig(cwd);
    if (!parsed) return [];

    const { mcpServers, disabledServers } = parsed;

    const enabledServers = [];
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if (!disabledServers.has(serverName)) {
        // 跳过无效的服务器配置
        if (!isValidServerConfig(serverConfig)) {
          log('warn', `Skipping invalid server config: ${serverName}`);
          continue;
        }
        enabledServers.push({ name: serverName, config: serverConfig });
      }
    }

    log('info', '[MCP Config] Loaded', enabledServers.length, 'enabled MCP servers');
    return enabledServers;
  } catch (error) {
    log('error', 'Failed to load MCP servers config:', error.message);
    return [];
  }
}

/**
 * 加载所有 MCP 服务器信息（包括被禁用和配置无效的）
 * 合并全局和项目级别的 mcpServers，确保与 Java 端看到的服务器列表一致
 * @param {string} cwd - 当前工作目录
 * @returns {Promise<{enabled: Array, disabled: Array<string>, invalid: Array<{name: string, reason: string}>}>}
 */
export async function loadAllMcpServersInfo(cwd = null) {
  const result = { enabled: [], disabled: [], invalid: [] };

  try {
    const parsed = await parseMcpConfig(cwd);
    if (!parsed) return result;

    const { mcpServers, disabledServers } = parsed;

    // 收集项目范围内的服务器名
    const processedNames = new Set();

    // 先处理项目/全局解析出来的服务器（parseMcpConfig 的结果）
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      processedNames.add(serverName);
      classifyServer(serverName, serverConfig, disabledServers, result);
    }

    // 如果指定了 cwd，全局服务器可能被项目配置覆盖了
    // 需要额外读取全局配置，补充那些只存在于全局的服务器
    if (cwd) {
      const globalParsed = await parseMcpConfig(null);
      if (globalParsed) {
        for (const [serverName, serverConfig] of Object.entries(globalParsed.mcpServers)) {
          if (processedNames.has(serverName)) continue; // 项目配置已包含，跳过
          processedNames.add(serverName);
          classifyServer(serverName, serverConfig, globalParsed.disabledServers, result);
        }
      }
    }

    log('info', '[MCP Config] All servers:', result.enabled.length, 'enabled,', result.disabled.length, 'disabled,', result.invalid.length, 'invalid');
    return result;
  } catch (error) {
    log('error', 'Failed to load all MCP servers info:', error.message);
    return result;
  }
}

/**
 * 将服务器分类到 enabled/disabled/invalid
 */
function classifyServer(serverName, serverConfig, disabledServers, result) {
  if (disabledServers.has(serverName)) {
    result.disabled.push(serverName);
  } else if (!isValidServerConfig(serverConfig)) {
    const hasCommand = typeof serverConfig?.command === 'string' && serverConfig.command.length > 0;
    const hasUrl = typeof serverConfig?.url === 'string' && serverConfig.url.length > 0;
    const reason = !hasCommand && !hasUrl
      ? 'Missing command or url'
      : 'Invalid config structure';
    result.invalid.push({ name: serverName, reason });
  } else {
    result.enabled.push({ name: serverName, config: serverConfig });
  }
}
