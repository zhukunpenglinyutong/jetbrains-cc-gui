/**
 * MCP 配置加载模块
 * 提供从 ~/.claude.json 读取 MCP 服务器配置的功能
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
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
 * 从 ~/.claude.json 读取 MCP 服务器配置
 * 支持两种模式：
 * 1. 全局配置 - 使用全局 mcpServers
 * 2. 项目配置 - 使用项目特定的 mcpServers
 * @param {string} cwd - 当前工作目录（用于检测项目）
 * @returns {Promise<Array<{name: string, config: Object}>>} 启用的 MCP 服务器列表
 */
export async function loadMcpServersConfig(cwd = null) {
  try {
    const claudeJsonPath = join(homedir(), '.claude.json');

    if (!existsSync(claudeJsonPath)) {
      log('info', '~/.claude.json not found');
      return [];
    }

    const content = await readFile(claudeJsonPath, 'utf8');
    const config = JSON.parse(content);

    // 验证配置结构
    const validation = validateConfigStructure(config);
    if (!validation.valid) {
      log('error', 'Invalid config structure:', validation.reason);
      return [];
    }

    // 规范化路径以匹配配置中的路径格式
    let normalizedCwd = cwd;
    if (cwd) {
      // 将路径转换为绝对路径并统一使用正斜杠
      normalizedCwd = cwd.replace(/\\/g, '/');
      // 移除尾部斜杠
      normalizedCwd = normalizedCwd.replace(/\/$/, '');
    }

    // 查找匹配的项目配置
    let projectConfig = null;
    if (normalizedCwd && config.projects) {
      // 尝试精确匹配项目路径
      if (config.projects[normalizedCwd]) {
        projectConfig = config.projects[normalizedCwd];
      } else {
        // 尝试将 cwd 转换为不同的格式进行匹配
        const cwdVariants = [
          normalizedCwd,
          normalizedCwd.replace(/\//g, '\\'),  // Windows 反斜杠格式
          '/' + normalizedCwd,                  // Unix 绝对路径格式
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
      // 模式 2: 使用项目特定的 MCP 配置
      log('info', '[MCP Config] Using project-specific MCP configuration');

      // 检查项目是否有自己的 mcpServers
      if (Object.keys(projectConfig.mcpServers || {}).length > 0) {
        mcpServers = projectConfig.mcpServers;
        disabledServers = new Set(projectConfig.disabledMcpServers || []);
      } else {
        // 项目没有自己的 mcpServers，使用全局配置
        // 但要应用项目级别的禁用列表
        log('info', '[MCP Config] Project has no MCP servers, using global config');
        mcpServers = config.mcpServers || {};

        // 合并全局和项目的禁用列表
        const globalDisabled = config.disabledMcpServers || [];
        const projectDisabled = projectConfig.disabledMcpServers || [];
        disabledServers = new Set([...globalDisabled, ...projectDisabled]);
      }
    } else {
      // 模式 1: 使用全局 MCP 配置
      log('info', '[MCP Config] Using global MCP configuration');
      mcpServers = config.mcpServers || {};
      disabledServers = new Set(config.disabledMcpServers || []);
    }

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
