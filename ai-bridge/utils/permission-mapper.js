/**
 * Permission Mapping Utility
 *
 * Maps unified permission concepts across different AI providers.
 * Each provider has its own permission model - this module provides
 * bidirectional translation between unified and provider-specific formats.
 *
 * Philosophy: "Simple is better than complex" - Zen of Python
 *
 * @author Inspired by Steve Jobs' pursuit of simplicity
 */

/**
 * Unified Permission Modes
 *
 * These are the canonical permission levels understood by the IDEA plugin.
 * All providers must map their native permissions to these modes.
 */
export const UnifiedPermissionMode = {
  /** Default: Ask user before dangerous operations */
  DEFAULT: 'default',
  /** Read-only: No file modifications or command execution */
  SANDBOX: 'sandbox',
  /** Full access: Auto-approve all operations */
  YOLO: 'yolo'
};

/**
 * Normalize arbitrary permission mode strings to our canonical identifiers.
 * Accepts values coming from the webview (e.g. `bypassPermissions`) as well as
 * internal unified constants (e.g. `yolo`). Defaults to `default`.
 *
 * @param {string|undefined|null} mode
 * @returns {{core: string, alias?: string}}
 */
function normalizeUnifiedMode(mode) {
  if (!mode) {
    return { core: UnifiedPermissionMode.DEFAULT };
  }

  const raw = mode.toString().trim();
  const normalized = raw.toLowerCase();

  if (normalized === 'bypasspermissions') {
    return { core: UnifiedPermissionMode.YOLO, alias: 'bypassPermissions' };
  }

  // acceptEdits (Agent Mode): 自动应用文件修改，命令仍需确认
  if (normalized === 'acceptedits') {
    return { core: UnifiedPermissionMode.DEFAULT, alias: 'acceptEdits' };
  }

  if (normalized === 'plan' || normalized === UnifiedPermissionMode.SANDBOX) {
    return { core: UnifiedPermissionMode.SANDBOX };
  }

  if (normalized === UnifiedPermissionMode.YOLO) {
    return { core: UnifiedPermissionMode.YOLO };
  }

  return { core: UnifiedPermissionMode.DEFAULT };
}

/**
 * Claude Permission Mapping
 *
 * Claude uses simple string-based permission modes that align
 * well with our unified model.
 */
export class ClaudePermissionMapper {
  /**
   * Convert unified permission mode to Claude format
   * @param {string} unifiedMode - One of UnifiedPermissionMode values
   * @returns {string} Claude permission mode
   */
  static toProvider(unifiedMode) {
    switch (unifiedMode) {
      case UnifiedPermissionMode.DEFAULT:
        return 'default';
      case UnifiedPermissionMode.SANDBOX:
        return 'sandbox';
      case UnifiedPermissionMode.YOLO:
        return 'yolo';
      default:
        return 'default';
    }
  }

  /**
   * Convert Claude permission mode to unified format
   * @param {string} claudeMode - Claude permission mode
   * @returns {string} Unified permission mode
   */
  static fromProvider(claudeMode) {
    // Claude modes already match our unified model
    return claudeMode || UnifiedPermissionMode.DEFAULT;
  }
}

/**
 * Codex Permission Mapping
 *
 * Codex uses a different permission model based on:
 * - skipGitRepoCheck: boolean (safety check bypass)
 * - sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
 *
 * We map these to our unified modes.
 */
export class CodexPermissionMapper {
  /**
   * Convert unified permission mode to Codex configuration
   * @param {string} unifiedMode - One of UnifiedPermissionMode values
   * @returns {{skipGitRepoCheck: boolean, sandbox?: string}} Codex permission config
   */
  static toProvider(unifiedMode) {
    const { core, alias } = normalizeUnifiedMode(unifiedMode);

    // Treat bypassPermissions (Full Auto / trusted) as workspace-write but completely auto-approved.
    if (alias === 'bypassPermissions') {
      return {
        skipGitRepoCheck: true,
        sandbox: 'workspace-write',
        approvalPolicy: 'never'
      };
    }

    // acceptEdits (Agent Mode): 自动应用文件修改，命令仍需确认
    if (alias === 'acceptEdits') {
      return {
        skipGitRepoCheck: true,
        sandbox: 'workspace-write',
        approvalPolicy: 'auto-edit'  // Codex 的 auto-edit 模式
      };
    }

    switch (core) {
      case UnifiedPermissionMode.SANDBOX:
        // Sandbox: Read-only mode (always prompt when attempting to write)
        return {
          skipGitRepoCheck: true,
          sandbox: 'read-only',
          approvalPolicy: 'untrusted'
        };

      case UnifiedPermissionMode.YOLO:
        // YOLO: Full access, no restrictions (explicit yolo selection)
        return {
          skipGitRepoCheck: true,
          sandbox: 'danger-full-access',
          approvalPolicy: 'never'
        };

      case UnifiedPermissionMode.DEFAULT:
      default:
        // Default: Allow workspace writes but still prompt before executing risky actions
        return {
          skipGitRepoCheck: true,
          sandbox: 'workspace-write',
          approvalPolicy: 'untrusted'
        };
    }
  }

  /**
   * Convert Codex configuration to unified permission mode
   * @param {{skipGitRepoCheck?: boolean, sandbox?: string}} codexConfig
   * @returns {string} Unified permission mode
   */
  static fromProvider(codexConfig) {
    if (!codexConfig || !codexConfig.sandbox) {
      return UnifiedPermissionMode.DEFAULT;
    }

    switch (codexConfig.sandbox) {
      case 'read-only':
        return UnifiedPermissionMode.SANDBOX;
      case 'danger-full-access':
        return UnifiedPermissionMode.YOLO;
      case 'workspace-write':
      default:
        return UnifiedPermissionMode.DEFAULT;
    }
  }
}

/**
 * Permission Mapper Factory
 *
 * Automatically selects the correct mapper based on provider type.
 * This is the main entry point for permission translation.
 *
 * Usage:
 *   const mapper = PermissionMapperFactory.getMapper('codex');
 *   const providerConfig = mapper.toProvider('yolo');
 */
export class PermissionMapperFactory {
  /**
   * Get permission mapper for a specific provider
   * @param {'claude'|'codex'|'gemini'} provider
   * @returns {ClaudePermissionMapper|CodexPermissionMapper}
   */
  static getMapper(provider) {
    switch (provider) {
      case 'claude':
        return ClaudePermissionMapper;
      case 'codex':
        return CodexPermissionMapper;
      case 'gemini':
        // TODO: Implement GeminiPermissionMapper when adding Gemini support
        throw new Error('Gemini permission mapping not yet implemented');
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  /**
   * Quick conversion: unified → provider-specific
   * @param {'claude'|'codex'|'gemini'} provider
   * @param {string} unifiedMode
   * @returns {string|object} Provider-specific permission config
   */
  static toProvider(provider, unifiedMode) {
    const mapper = this.getMapper(provider);
    return mapper.toProvider(unifiedMode);
  }

  /**
   * Quick conversion: provider-specific → unified
   * @param {'claude'|'codex'|'gemini'} provider
   * @param {string|object} providerConfig
   * @returns {string} Unified permission mode
   */
  static fromProvider(provider, providerConfig) {
    const mapper = this.getMapper(provider);
    return mapper.fromProvider(providerConfig);
  }
}
