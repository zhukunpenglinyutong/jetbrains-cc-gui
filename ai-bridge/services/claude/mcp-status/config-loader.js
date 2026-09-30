/**
 * MCP configuration loader module
 * Provides functionality to read MCP server configuration from ~/.claude.json
 */

import { existsSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'path';
import { getRealHomeDir, getManagedSettingsPath } from '../../../utils/path-utils.js';
import { log } from './logger.js';

/**
 * Expand ${VAR} placeholders in an MCP server env value
 *
 * Claude Code resolves these from the `env` section of
 * `.claude/settings.local.json` (project) and `.claude/settings.json`
 * (user), falling back to the process environment. The plugin passed the
 * literal placeholder through to the spawned MCP server, so containers
 * received e.g. DATABASE_URI=${NEXUS_MCP_DB_URI} verbatim (#1722).
 *
 * Lookup order (first hit wins): project settings.local env -> user
 * settings env -> process.env. Unresolvable placeholders are left as-is so
 * misconfiguration stays visible in logs instead of becoming empty strings.
 *
 * @param {string} value - Raw env value that may contain ${VAR} placeholders
 * @param {Object} projectEnv - env map from .claude/settings.local.json
 * @param {Object} userEnv - env map from .claude/settings.json
 * @returns {string} Value with all resolvable ${VAR} placeholders expanded
 */
function expandEnvPlaceholders(value, projectEnv, userEnv) {
  if (typeof value !== 'string' || !value.includes('${')) return value;
  // ${VAR} only - no command substitution, nesting, or defaults syntax
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(projectEnv, name)) {
      console.error('[DEBUG] MCP Config: ${' + name + '} resolved from projectEnv=' + (projectEnv[name] ? '[SET]' : '[UNSET]'));
      return String(projectEnv[name]);
    }
    if (Object.prototype.hasOwnProperty.call(userEnv, name)) {
      console.error('[DEBUG] MCP Config: ${' + name + '} resolved from userEnv=' + (userEnv[name] ? '[SET]' : '[UNSET]'));
      return String(userEnv[name]);
    }
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      console.error('[DEBUG] MCP Config: ${' + name + '} resolved from process.env=' + (process.env[name] ? '[SET]' : '[UNSET]'));
      return process.env[name];
    }
    log('warn', `[MCP Config] Unresolved \${${name}} placeholder left as-is in MCP env`);
    console.error('[DEBUG] MCP Config: ${' + name + '} unresolved (not found in projectEnv, userEnv, or process.env)');
    return match;
  });
}

/**
 * Load the env override maps used for ${VAR} expansion
 *
 * Reads the `env` section of .claude/settings.local.json (project-local,
 * git-ignored, where secrets live) and .claude/settings.json (user-level),
 * matching the resolution order Claude Code uses for .mcp.json placeholders.
 * Files that are missing, unparseable, or have no env section produce {}.
 *
 * @param {string} cwd - Current working directory (project root)
 * @returns {Promise<{projectEnv: Object, userEnv: Object}>} env maps
 */
async function loadEnvExpansionSources(cwd) {
  const projectEnv = {};
  const userEnv = {};

  const sources = [
    { label: 'project settings.local.json', file: cwd ? join(cwd, '.claude', 'settings.local.json') : null, into: projectEnv },
    { label: 'user settings.json', file: join(getRealHomeDir(), '.claude', 'settings.json'), into: userEnv }
  ];

  for (const source of sources) {
    if (!source.file || !existsSync(source.file)) continue;
    try {
      const parsed = JSON.parse(await readFile(source.file, 'utf8'));
      if (parsed && typeof parsed.env === 'object' && parsed.env !== null) {
        Object.assign(source.into, parsed.env);
      }
    } catch (e) {
      log('warn', `[MCP Config] Failed to read ${source.label} for env expansion:`, e.message);
    }
  }

  return { projectEnv, userEnv };
}

/**
 * Apply ${VAR} expansion to every env value of every server config
 * @param {Object} mcpServers - Server name -> config map
 * @param {Object} projectEnv - env map from .claude/settings.local.json
 * @param {Object} userEnv - env map from .claude/settings.json
 * @returns {Object} New map with expanded env values (input is not mutated)
 */
function expandMcpServersEnv(mcpServers, projectEnv, userEnv) {
  const expanded = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (config && typeof config === 'object' && config.env && typeof config.env === 'object') {
      const env = {};
      for (const [key, value] of Object.entries(config.env)) {
        env[key] = expandEnvPlaceholders(value, projectEnv, userEnv);
      }
      expanded[name] = { ...config, env };
    } else {
      expanded[name] = config;
    }
  }
  return expanded;
}

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
 * Load a project-level .mcp.json file from the project root.
 *
 * Claude Code also supports a .mcp.json file at the project root (separate from
 * the project-level mcpServers block inside ~/.claude.json). This function reads
 * that file and returns its mcpServers and disabledMcpServers, or null if the
 * file doesn't exist.
 *
 * @param {string|null} cwd - Project root directory
 * @returns {Promise<{mcpServers: Object, disabledServers: Set<string>} | null>} Parsed config, or null
 */
async function loadProjectMcpJson(cwd = null) {
  if (!cwd) return null;
  const mcpJsonPath = join(cwd, '.mcp.json');
  if (!existsSync(mcpJsonPath)) {
    log('info', '[MCP Config] .mcp.json not found at', mcpJsonPath);
    return null;
  }
  try {
    const content = await readFile(mcpJsonPath, 'utf8');
    const config = JSON.parse(content);
    log('info', '[MCP Config] Loaded .mcp.json from', mcpJsonPath);
    return {
      mcpServers: config.mcpServers || {},
      disabledServers: new Set(config.disabledMcpServers || []),
    };
  } catch (e) {
    log('warn', '[MCP Config] Failed to read .mcp.json:', e.message);
    return null;
  }
}

/**
 * Merge project-level .mcp.json servers into the existing server map.
 * Project servers are marked with source: 'project' to distinguish them from
 * ~/.claude.json servers in the UI (read-only display).
 * @param {Object} mcpServers - Existing server config map (from ~/.claude.json)
 * @param {Object} projectMcpServers - Servers from .mcp.json
 * @returns {Object} Merged server map
 */
function mergeProjectMcpServers(mcpServers, projectMcpServers) {
  if (!projectMcpServers) return mcpServers;
  const merged = {};
  // Project entries first, then user entries override them — a project must
  // NOT shadow a same-named user server (defense in depth).
  for (const [name, config] of Object.entries(projectMcpServers)) {
    merged[name] = { ...config, source: 'project' };
  }
  for (const [name, config] of Object.entries(mcpServers || {})) {
    merged[name] = config;
  }
  return merged;
}

/**
 * Settings keys controlling approval of project-scoped .mcp.json servers.
 *
 * These are deliberately distinct from `enabledMcpServers` / `disabledMcpServers`,
 * which drive the per-project /mcp toggle list for ~/.claude.json servers.
 * Conflating the two is the bug this gate exists to prevent.
 */
const PROJECT_APPROVAL_KEYS = {
  ENABLED: 'enabledMcpjsonServers',
  DISABLED: 'disabledMcpjsonServers',
  ENABLE_ALL: 'enableAllProjectMcpServers',
};

/**
 * Read and parse a settings file synchronously, tolerating every failure mode.
 * @param {string|null} filePath - Absolute path, or null to skip
 * @param {string} label - Human-readable label used in log messages
 * @returns {Object|null} Parsed object, or null when missing/unparseable/not an object
 */
function readSettingsFileSync(filePath, label) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log('warn', `[MCP Approve] ${label} is not a JSON object; ignoring`);
      return null;
    }
    return parsed;
  } catch (e) {
    log('warn', `[MCP Approve] Failed to read ${label}:`, e.message);
    return null;
  }
}

/** Repo-relative path of the project-local settings file, used for git probes. */
const PROJECT_LOCAL_SETTINGS_REL = '.claude/settings.local.json';

/** git trust probes run on the project-open path; never let them stall the UI. */
const GIT_TRUST_PROBE_TIMEOUT_MS = 5_000;

/**
 * Run a read-only `git` command inside the project directory.
 *
 * Never uses a shell: arguments are passed as an array, so a project path can
 * never be reinterpreted as shell syntax. Follows the daemon's existing
 * `spawnSync(bin, [args], { timeout })` style (utils/cli-path.js, dsh/supervisor.js).
 *
 * @param {string[]} args - git arguments, without the leading `git`
 * @param {string} cwd - Project root to run the command in
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, reason: string|null}} Probe result
 */
function runGitProbe(args, cwd) {
  let result;
  try {
    result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TRUST_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
  } catch (e) {
    return { ok: false, status: null, stdout: '', stderr: '', reason: `git probe threw: ${e.message}` };
  }
  if (!result) return { ok: false, status: null, stdout: '', stderr: '', reason: 'git returned no result' };
  if (result.error) {
    const code = result.error.code;
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      reason: code === 'ETIMEDOUT' ? 'git timed out' : `git unavailable (${code || 'spawn error'})`,
    };
  }
  if (result.signal) {
    return { ok: false, status: null, stdout: '', stderr: '', reason: `git killed by signal ${result.signal}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      reason: `git ${args[0]} exited with code ${result.status}`,
    };
  }
  return { ok: true, status: 0, stdout: result.stdout || '', stderr: result.stderr || '', reason: null };
}

/**
 * Whether a failed git probe is git's own definitive "this directory is not a
 * repository" answer (exit 128 + `fatal: not a git repository`), as opposed to a
 * failure we simply could not interpret. Only the former may relax the gate.
 *
 * @param {{ok: boolean, status: number|null, stderr: string}} probe - Probe result
 * @returns {boolean} True for a clean "not a repository" answer
 */
function isNotARepositoryFailure(probe) {
  return probe.status === 128 && probe.stderr.includes('not a git repository');
}

/**
 * Decide whether the project's `.claude/settings.local.json` may contribute
 * approval state.
 *
 * Being called "local" is not evidence of anything: a hostile repository can
 * simply commit `.claude/settings.local.json` (with `git add -f`, or with no
 * .gitignore entry at all) and a clone then carries an
 * `enableAllProjectMcpServers: true` that auto-approves every server in the
 * committed `.mcp.json` — no Approve click, no prompt. So the claim is checked
 * against git instead of assumed:
 *
 * 0. `git rev-parse --is-inside-work-tree` must exit 0. A definitive "not a
 *    git repository" is the one case where no repository can ever commit the
 *    file, so the explicit per-server lists are still read — otherwise Approve
 *    would write a file that can never count and the UI would sit at "pending"
 *    forever in every non-version-controlled project, buying nothing. The
 *    verdict then carries `trustVerified: false`, because git did NOT confirm
 *    anything, and the UI has to say so. Any other failure of this probe
 *    (git missing, timeout) stays untrusted.
 * 1. `git ls-files --error-unmatch -- <path>` must exit 1 (path NOT in the
 *    index). Exit 0 means tracked/committed -> untrusted. Any other exit
 *    (spawn failure, timeout) -> untrusted.
 * 2. `git check-ignore --quiet -- <path>` must exit 0 (path covered by
 *    .gitignore), so a later `git add .` cannot promote it. Exit 1 (not
 *    ignored) or any error -> untrusted.
 *
 * Everything except step 0's clean "not a repository" is fail-closed: if git
 * cannot answer the question, the file is not trusted. Only the path and the
 * reason are logged — never file contents.
 *
 * @param {string} cwd - Project root
 * @param {string} file - Absolute path to the candidate settings file
 * @returns {{trusted: boolean, present: boolean, trustVerified: boolean, reason: string|null}} Trust verdict
 */
function checkProjectLocalSettingsTrust(cwd, file) {
  if (!existsSync(file)) return { trusted: false, present: false, trustVerified: false, reason: null };

  const inside = runGitProbe(['rev-parse', '--is-inside-work-tree'], cwd);
  if (!inside.ok) {
    if (isNotARepositoryFailure(inside)) {
      log('warn', '[MCP Approve] project dir is not a git repository; reading explicit '
        + 'enabledMcpjsonServers from settings.local.json, but the trust is NOT git-verified');
      return { trusted: true, present: true, trustVerified: false, reason: null };
    }
    return { trusted: false, present: true, trustVerified: false, reason: inside.reason };
  }

  const tracked = runGitProbe(['ls-files', '--error-unmatch', '--', PROJECT_LOCAL_SETTINGS_REL], cwd);
  if (tracked.ok) {
    return {
      trusted: false, present: true, trustVerified: false,
      reason: 'the file is tracked by git (staged or committed)',
    };
  }
  if (tracked.status !== 1) {
    // null = git missing/spawn failure/timeout.
    return { trusted: false, present: true, trustVerified: false, reason: tracked.reason };
  }

  const ignored = runGitProbe(['check-ignore', '--quiet', '--', PROJECT_LOCAL_SETTINGS_REL], cwd);
  if (!ignored.ok) {
    return {
      trusted: false,
      present: true,
      trustVerified: false,
      reason: ignored.status === 1 ? 'the file is not covered by .gitignore' : ignored.reason,
    };
  }

  return { trusted: true, present: true, trustVerified: true, reason: null };
}

/**
 * List the settings files whose approval entries may be trusted.
 *
 * Claude Code's trust model (v2.1.196+) is that a cloned repository cannot
 * approve its own servers, so the project's committed `.claude/settings.json`
 * is deliberately absent from this list: an `enabledMcpjsonServers` entry (or
 * `enableAllProjectMcpServers`) committed there leaves the server at "pending
 * approval". Only these sources count:
 * - user `~/.claude/settings.json`
 * - managed `managed-settings.json` (enterprise-controlled)
 * - the project's `.claude/settings.local.json` — this plugin writes it when
 *   the user clicks Approve, but only when it is genuinely machine-local,
 *   i.e. untracked AND git-ignored (see checkProjectLocalSettingsTrust).
 *   A tracked copy is dropped entirely, so a committed file cannot approve
 *   anything.
 *
 * A `disabledMcpjsonServers` entry in any of them still rejects the server.
 *
 * @param {string|null} cwd - Project root
 * @returns {Array<{label: string, file: string, scope: 'user'|'managed'|'project-local', trustVerified: boolean}>} Sources to read, in order
 */
function collectApprovalSettingsSources(cwd) {
  // User/managed files live outside any repository, so their trust needs no git proof.
  const sources = [
    { label: 'user settings.json', file: join(getRealHomeDir(), '.claude', 'settings.json'), scope: 'user', trustVerified: true },
    { label: 'managed-settings.json', file: getManagedSettingsPath(), scope: 'managed', trustVerified: true },
  ];
  if (cwd) {
    const file = join(cwd, '.claude', 'settings.local.json');
    const verdict = checkProjectLocalSettingsTrust(cwd, file);
    if (verdict.trusted) {
      sources.push({
        label: 'project settings.local.json',
        file,
        scope: 'project-local',
        trustVerified: verdict.trustVerified,
      });
    } else if (verdict.present) {
      log('warn', `[MCP Approve] project settings.local.json is NOT trusted (${verdict.reason}); its approval entries are ignored`);
    }
  }
  return sources;
}

/**
 * Resolve the approval state for project-scoped .mcp.json servers.
 *
 * Rejection always wins: a name in `disabledMcpjsonServers` stays denied even
 * when it also appears in `enabledMcpjsonServers` or `enableAllProjectMcpServers`
 * is true, matching Claude Code's "blocks it in every permission mode".
 *
 * `enableAllProjectMcpServers` is accepted ONLY from user / managed scope. Even
 * a machine-local `.claude/settings.local.json` may contribute an explicit list
 * of names, but never a blanket "approve everything shipped in this repo's
 * .mcp.json" — that is exactly the flag a hostile repository wants written for
 * it, and it is a one-liner to add later.
 *
 * `trustVerified` reports, per approved name, whether the source that granted
 * the approval was positively confirmed by git. It is `false` only when the
 * name was approved exclusively through a project-local file in a directory
 * that is not a git repository — the one case where trust rests on the absence
 * of git rather than on git's answer. User/managed scope is always verified.
 * A name listed in several sources counts as verified when ANY of them verifies
 * it, so adding a user-scope entry repairs an unverified approval.
 *
 * @param {string|null} cwd - Project root
 * @returns {{approved: Set<string>, denied: Set<string>, approveAll: boolean, trustVerified: Map<string, boolean>}} Resolved approval state
 */
function getProjectMcpApproval(cwd = null) {
  const approved = new Set();
  const denied = new Set();
  const trustVerified = new Map();
  let approveAll = false;

  for (const source of collectApprovalSettingsSources(cwd)) {
    const settings = readSettingsFileSync(source.file, source.label);
    if (!settings) continue;

    if (settings[PROJECT_APPROVAL_KEYS.ENABLE_ALL] === true) {
      if (source.scope === 'project-local') {
        log('warn', `[MCP Approve] ${source.label}: ignoring enableAllProjectMcpServers — ` +
          'only user/managed scope may approve all project servers');
      } else {
        approveAll = true;
        log('info', `[MCP Approve] ${source.label}: enableAllProjectMcpServers=true`);
      }
    }
    for (const key of [PROJECT_APPROVAL_KEYS.ENABLED, PROJECT_APPROVAL_KEYS.DISABLED]) {
      const list = settings[key];
      if (!Array.isArray(list)) continue;
      const isEnabledList = key === PROJECT_APPROVAL_KEYS.ENABLED;
      const target = isEnabledList ? approved : denied;
      for (const name of list) {
        if (typeof name !== 'string' || name.length === 0) continue;
        target.add(name);
        if (isEnabledList) {
          // Verified wins: a name approved by any verified source is verified.
          if (trustVerified.get(name) !== true) {
            trustVerified.set(name, source.trustVerified !== false);
          }
        }
      }
    }
  }

  return { approved, denied, approveAll, trustVerified };
}

/**
 * Names explicitly approved for this project, or null when none are.
 * @param {string|null} cwd - Project root
 * @returns {Set<string>|null} Approved names
 */
function getApprovedProjectServers(cwd = null) {
  const { approved, approveAll } = getProjectMcpApproval(cwd);
  return approved.size === 0 && !approveAll ? null : approved;
}

/**
 * Names explicitly rejected for this project, or null when none are.
 * @param {string|null} cwd - Project root
 * @returns {Set<string>|null} Rejected names
 */
function getDeniedProjectServers(cwd = null) {
  const { denied } = getProjectMcpApproval(cwd);
  return denied.size > 0 ? denied : null;
}

/**
 * Whether a single project server may be spawned for this project.
 * @param {string} name - Server name from .mcp.json
 * @param {string|null} cwd - Project root
 * @returns {boolean} True only when approved and not rejected
 */
function isProjectServerApproved(name, cwd = null) {
  const { approved, denied, approveAll } = getProjectMcpApproval(cwd);
  if (denied.has(name)) return false;
  return approveAll || approved.has(name);
}

/**
 * Classify a .mcp.json server's approval state for display in the UI.
 * @param {string} name - Server name from .mcp.json
 * @param {string|null} cwd - Project root
 * @returns {'approved'|'rejected'|'pending'} Approval state
 */
function classifyProjectServerApproval(name, cwd = null) {
  const { approved, denied, approveAll } = getProjectMcpApproval(cwd);
  if (denied.has(name)) return 'rejected';
  return approveAll || approved.has(name) ? 'approved' : 'pending';
}

/**
 * Whether the trust behind a project .mcp.json server's approval is confirmed by
 * git — the `trustVerified` field the UI has to surface.
 *
 * `true`  — the approval came from user ~/.claude/settings.json, from managed
 *            settings, or from a project-local file that git proved is untracked
 *            and git-ignored. Nothing is left to caveat.
 * `false` — either the gate granted this server nothing (pending/rejected, so
 *            there is no verified provenance to claim), or its approval rests
 *            solely on a project-local file in a directory that is NOT a git
 *            repository, where trust comes from the absence of git rather than
 *            from git's answer. The UI must show that as "trust not verified".
 *
 * @param {string} name - Server name from .mcp.json
 * @param {string|null} cwd - Project root
 * @returns {boolean} True only when the trust basis is fully verified
 */
function isProjectServerTrustVerified(name, cwd = null) {
  const { approved, denied, approveAll, trustVerified } = getProjectMcpApproval(cwd);
  if (denied.has(name)) return false;
  // approveAll is only ever set from user/managed scope, i.e. always verified.
  if (approveAll) return true;
  if (!approved.has(name)) return false;
  return trustVerified.get(name) === true;
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

  // SECURITY: project-root .mcp.json can ship arbitrary command/args and is
  // therefore gated behind per-project, per-server approval (matching Claude
  // Code's supply-chain mitigation). Only servers the user explicitly approved
  // for this project are merged into the spawn path.
  const projectMcpJson = await loadProjectMcpJson(cwd);
  if (projectMcpJson) {
    // Resolve approval ONCE (sync settings reads) instead of per-server.
    // Denial wins over approval in every case, including enableAllProjectMcpServers.
    const { approved, denied, approveAll } = getProjectMcpApproval(cwd);

    const mergedProject = {};
    for (const [name, config] of Object.entries(projectMcpJson.mcpServers || {})) {
      if (denied.has(name)) {
        log('warn', `[MCP Config] Project server "${name}" rejected by disabledMcpjsonServers; skipping`);
        continue;
      }
      // A project may disable its OWN servers via .mcp.json disabledMcpServers.
      // The list never reaches user-scope servers (see the NOTE below).
      if (projectMcpJson.disabledServers && projectMcpJson.disabledServers.has(name)) {
        log('info', `[MCP Config] Project server "${name}" disabled by .mcp.json; skipping`);
        continue;
      }
      if (!approveAll && !approved.has(name)) {
        log('warn', `[MCP Config] Project server "${name}" is pending approval; skipping`);
        continue;
      }
      mergedProject[name] = config;
    }

    if (Object.keys(mergedProject).length > 0) {
      mcpServers = mergeProjectMcpServers(mcpServers, mergedProject);
      log('info', '[MCP Config] Merged', Object.keys(mergedProject).length,
          'approved project servers from .mcp.json');
    } else {
      log('info', '[MCP Config] No approved project servers in .mcp.json; nothing merged');
    }

    // NOTE: project disabledMcpServers must NOT affect user-scope servers.
    // Do not add projectMcpJson.disabledServers to disabledServers here.
  }

  // Expand ${VAR} placeholders in server env values (e.g. from
  // .claude/settings.local.json) so spawned servers receive real values,
  // matching Claude Code's behaviour for the same config (#1722).
  const { projectEnv, userEnv } = await loadEnvExpansionSources(cwd);
  mcpServers = expandMcpServersEnv(mcpServers, projectEnv, userEnv);

  return { mcpServers, disabledServers };
}

export { loadProjectMcpJson, mergeProjectMcpServers, getApprovedProjectServers, getDeniedProjectServers, isProjectServerApproved, classifyProjectServerApproval, isProjectServerTrustVerified, getProjectMcpApproval };

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
 * Load enabled MCP server config and return as a Record<name, config> for the
 * Claude Agent SDK's `mcpServers` option.
 *
 * Returns null (rather than an empty object) when no servers are enabled, so
 * callers can naturally write `...(mcpServers && { mcpServers })` to omit the
 * field from SDK options entirely.
 *
 * @param {string} cwd - Current working directory (used for project detection)
 * @returns {Promise<Record<string, Object> | null>}
 */
export async function loadMcpServersConfigAsRecord(cwd = null) {
  const list = await loadMcpServersConfig(cwd);
  if (list.length === 0) return null;
  return Object.fromEntries(list.map(({ name, config }) => [name, config]));
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
      classifyServer(serverName, serverConfig, disabledServers, result, cwd);
    }

    // If cwd is specified, global servers may have been overridden by project config.
    // Read the global config separately to pick up servers that only exist globally.
    if (cwd) {
      const globalParsed = await parseMcpConfig(null);
      if (globalParsed) {
        for (const [serverName, serverConfig] of Object.entries(globalParsed.mcpServers)) {
          if (processedNames.has(serverName)) continue; // Already covered by project config, skip
          processedNames.add(serverName);
          classifyServer(serverName, serverConfig, globalParsed.disabledServers, result, cwd);
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
 *
 * Enabled entries carry the `trustVerified` flag the UI surfaces: for a
 * project-scoped server it says whether git confirmed the trust behind its
 * approval; for a user-scope server (no `source: 'project'`) the gate does not
 * apply, so there is no unverified caveat to report.
 *
 * @param {string} serverName - Server name
 * @param {Object} serverConfig - Server config (may carry `source: 'project'`)
 * @param {Set<string>} disabledServers - Disabled server names
 * @param {Object} result - Accumulator mutated in place
 * @param {string|null} cwd - Project root, for the project approval gate
 */
function classifyServer(serverName, serverConfig, disabledServers, result, cwd = null) {
  const isProjectScoped = Boolean(serverConfig && serverConfig.source === 'project');
  const trustVerified = isProjectScoped
    ? isProjectServerTrustVerified(serverName, cwd)
    : true;

  if (disabledServers.has(serverName)) {
    result.disabled.push(serverName);
  } else if (!isValidServerConfig(serverConfig)) {
    const hasCommand = typeof serverConfig?.command === 'string' && serverConfig.command.length > 0;
    const hasUrl = typeof serverConfig?.url === 'string' && serverConfig.url.length > 0;
    const reason = !hasCommand && !hasUrl
      ? 'Missing command or url'
      : 'Invalid config structure';
    result.invalid.push({ name: serverName, reason, trustVerified });
  } else {
    // trustVerified sits on the ENTRY, never inside `config` — this config object
    // is also what feeds the SDK `mcpServers` spawn option.
    result.enabled.push({ name: serverName, config: serverConfig, trustVerified });
  }
}
