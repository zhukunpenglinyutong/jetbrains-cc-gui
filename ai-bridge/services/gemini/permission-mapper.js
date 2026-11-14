/**
 * Maps unified permission modes to and from Antigravity CLI (agy) posture flags.
 */
export class GeminiPermissionMapper {
  /**
   * Converts a unified permission mode to agy CLI spawn flags.
   *
   * @param {string} unifiedMode Unified permission mode identifier ('default'|'plan'|'acceptEdits'|'bypassPermissions'|'sandbox').
   * @returns {{args: string[]}} cli flags to append to the spawn arguments
   */
  static toProvider(unifiedMode) {
    const normalized = typeof unifiedMode === 'string' ? unifiedMode.trim().toLowerCase() : '';
    switch (normalized) {
      case 'plan':
        return { args: ['--mode', 'plan'] };
      case 'acceptedits':
        return { args: ['--mode', 'accept-edits'] };
      case 'bypasspermissions':
        return { args: ['--dangerously-skip-permissions'] };
      case 'sandbox':
        return { args: ['--sandbox'] };
      default:
        // Deny-by-default outside the chosen posture — no auto-approve flags.
        return { args: [] };
    }
  }

  /**
   * Converts agy CLI spawn flags back to a unified permission mode.
   *
   * @param {string[]|{args?: string[]}} providerConfig Spawn arguments array or object wrapper containing args.
   * @returns {string} unified permission mode ('default' when unrecognized)
   */
  static fromProvider(providerConfig) {
    const args = Array.isArray(providerConfig)
      ? providerConfig
      : (Array.isArray(providerConfig && providerConfig.args) ? providerConfig.args : []);
    if (args.includes('--dangerously-skip-permissions')) return 'bypassPermissions';
    if (args.includes('--sandbox')) return 'sandbox';
    const modeIndex = args.indexOf('--mode');
    if (modeIndex !== -1) {
      if (args[modeIndex + 1] === 'plan') return 'plan';
      if (args[modeIndex + 1] === 'accept-edits') return 'acceptEdits';
    }
    return 'default';
  }
}
