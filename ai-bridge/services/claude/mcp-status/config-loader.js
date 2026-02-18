/**
 * MCP configuration loader module
 * Provides functionality to read MCP server configuration from ~/.claude.json
 */

import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { getRealHomeDir } from '../../../utils/path-utils.js';
import { log } from './logger.js';

/**
 * Validate the basic structure of an MCP server configuration
 * @param {Object} serverConfig - Server configuration object
 * @returns {boolean} Whether the configuration is valid
 */
function isValidServerConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== 'object') {
    return false;
  }
  // Must have command (stdio) or url (http)
  const hasCommand = typeof serverConfig.command === 'string' && serverConfig.command.length > 0;
  const hasUrl = typeof serverConfig.url === 'string' && serverConfig.url.length > 0;
  if (!hasCommand && !hasUrl) {
    return false;
  }
  // args must be an array if present
  if (serverConfig.args !== undefined && !Array.isArray(serverConfig.args)) {
    return false;
  }
  // env must be an object if present
  if (serverConfig.env !== undefined && (typeof serverConfig.env !== 'object' || serverConfig.env === null)) {
    return false;
  }
  return true;
}

/**
 * Validate the basic structure of a configuration file
 * @param {Object} config - Configuration object
 * @returns {{valid: boolean, reason?: string}} Validation result
 */
function validateConfigStructure(config) {
  if (!config || typeof config !== 'object') {
    return { valid: false, reason: 'Config must be an object' };
  }
  // mcpServers must be an object if present
  if (config.mcpServers !== undefined) {
    if (typeof config.mcpServers !== 'object' || config.mcpServers === null) {
      return { valid: false, reason: 'mcpServers must be an object' };
    }
    // Validate each server configuration
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (!isValidServerConfig(serverConfig)) {
        log('warn', `Invalid server config for "${name}", skipping`);
      }
    }
  }
  // disabledMcpServers must be an array if present
  if (config.disabledMcpServers !== undefined && !Array.isArray(config.disabledMcpServers)) {
    return { valid: false, reason: 'disabledMcpServers must be an array' };
  }
  // projects must be an object if present
  if (config.projects !== undefined && (typeof config.projects !== 'object' || config.projects === null)) {
    return { valid: false, reason: 'projects must be an object' };
  }
  return { valid: true };
}

/**
 * Parse the server list and disabled list from the MCP configuration file
 * Extracts shared logic used by both loadMcpServersConfig and loadAllMcpServersInfo
 * @param {string} cwd - Current working directory (used for project detection)
 * @returns {Promise<{mcpServers: Object, disabledServers: Set<string>} | null>} Parse result, or null on failure
 */
async function parseMcpConfig(cwd = null) {
  const claudeJsonPath = join(getRealHomeDir(), '.claude.json');

  if (!existsSync(claudeJsonPath)) {
    log('info', '~/.claude.json not found');
    return null;
  }

  const content = await readFile(claudeJsonPath, 'utf8');
  const config = JSON.parse(content);

  // Validate configuration structure
  const validation = validateConfigStructure(config);
  if (!validation.valid) {
    log('error', 'Invalid config structure:', validation.reason);
    return null;
  }

  // Normalize the path to match the path format used in config
  let normalizedCwd = cwd;
  if (cwd) {
    normalizedCwd = cwd.replace(/\\/g, '/');
    normalizedCwd = normalizedCwd.replace(/\/$/, '');
  }

  // Find a matching project configuration
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
 * Read MCP server configuration from ~/.claude.json
 * Supports two modes:
 * 1. Global config - uses the global mcpServers
 * 2. Project config - uses project-specific mcpServers
 * @param {string} cwd - Current working directory (used for project detection)
 * @returns {Promise<Array<{name: string, config: Object}>>} List of enabled MCP servers
 */
export async function loadMcpServersConfig(cwd = null) {
  try {
    const parsed = await parseMcpConfig(cwd);
    if (!parsed) return [];

    const { mcpServers, disabledServers } = parsed;

    const enabledServers = [];
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      if (!disabledServers.has(serverName)) {
        // Skip invalid server configurations
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
 * Load all MCP server info (including disabled and invalid ones)
 * Merges global and project-level mcpServers to stay consistent with the server list seen by the Java side
 * @param {string} cwd - Current working directory
 * @returns {Promise<{enabled: Array, disabled: Array<string>, invalid: Array<{name: string, reason: string}>}>}
 */
export async function loadAllMcpServersInfo(cwd = null) {
  const result = { enabled: [], disabled: [], invalid: [] };

  try {
    const parsed = await parseMcpConfig(cwd);
    if (!parsed) return result;

    const { mcpServers, disabledServers } = parsed;

    // Collect server names within the project scope
    const processedNames = new Set();

    // Process servers resolved from project/global config (the parseMcpConfig result) first
    for (const [serverName, serverConfig] of Object.entries(mcpServers)) {
      processedNames.add(serverName);
      classifyServer(serverName, serverConfig, disabledServers, result);
    }

    // If cwd is specified, global servers may have been overridden by project config.
    // Read the global config separately to pick up servers that only exist globally.
    if (cwd) {
      const globalParsed = await parseMcpConfig(null);
      if (globalParsed) {
        for (const [serverName, serverConfig] of Object.entries(globalParsed.mcpServers)) {
          if (processedNames.has(serverName)) continue; // Already covered by project config, skip
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
 * Classify a server into the enabled/disabled/invalid buckets
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
