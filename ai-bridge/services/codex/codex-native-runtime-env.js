/** Restores authorized CLI Login credential names for each new native child, without caching values in the daemon. */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'smol-toml';
import { getRealHomeDir } from '../../utils/path-utils.js';
import { ALLOWED_LOGIN_SHELLS } from '../../utils/cli-path.js';
import { isDangerousEnvVar, isWebviewControlledEnvVar } from '../../config/api-config.js';
import { CODEX_CLI_ENV_BLOCKLIST, PROXY_ENV_KEYS } from './codex-utils.js';

const execute = promisify(execFile);
const LEGAL_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const START = '__CODEMOSS_ENV_START__';
const END = '__CODEMOSS_ENV_END__';
const SHELL_SCRIPT = `for key in "$@"; do
  printf '%s%s\\n' '${START}' "$key"
  printenv "$key" 2>/dev/null || true
  printf '%s%s\\n' '${END}' "$key"
done`;

function isCredentialName(name) {
  return typeof name === 'string' && LEGAL_ENV_NAME.test(name)
    && !isDangerousEnvVar(name) && !isWebviewControlledEnvVar(name)
    && !CODEX_CLI_ENV_BLOCKLIST.has(name.toUpperCase()) && !PROXY_ENV_KEYS.has(name.toUpperCase());
}

/** Collects provider credential names using native TOML semantics; invalid configuration stays native-owned. */
export function collectCodexProviderEnvKeys(text) {
  try {
    const config = parse(String(text ?? ''), { integersAsBigInt: 'asNeeded' });
    return new Map(Object.entries(config.model_providers ?? {})
      .filter(([_id, provider]) => provider && Object.hasOwn(provider, 'env_key') && typeof provider.env_key === 'string')
      .map(([id, provider]) => [id, provider.env_key]));
  } catch { return new Map(); }
}

/** Looks up only validated names; startup output and stderr never become diagnostics or credential values. */
export async function lookupCodexShellEnvironment(keys, env, {
  platform = process.platform, exists = existsSync, execute: run = execute,
} = {}) {
  if (platform === 'win32' || !keys.length || !keys.every(isCredentialName)) return {};
  const shell = [env.SHELL, platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/sh']
    .find(candidate => ALLOWED_LOGIN_SHELLS.has(candidate) && !candidate.endsWith('/fish') && exists(candidate));
  if (!shell) return {};
  try {
    const output = await run(shell, ['-l', '-i', '-c', SHELL_SCRIPT, 'codemoss', ...keys], {
      encoding: 'utf8', env, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const stdout = String(output.stdout ?? '').replaceAll('\r\n', '\n');
    const values = {};
    for (const key of keys) {
      const start = `${START}${key}\n`;
      const end = `${END}${key}\n`;
      const offset = stdout.indexOf(start);
      const stop = offset < 0 ? -1 : stdout.indexOf(end, offset + start.length);
      if (stop < 0) continue;
      const value = stdout.slice(offset + start.length, stop).replace(/\n$/, '');
      if (value) Object.defineProperty(values, key, { value, enumerable: true });
    }
    return values;
  } catch {
    // Missing shell credentials remain the native provider's authentication failure.
    return {};
  }
}

/** Supplements a new CLI Login child; managed credentials never enter this discovery path. */
export async function prepareCodexRuntimeEnvironment({
  authMode, env = {}, baseEnv = env, codexHome = null, config = null, onCredentialNames = null,
}, { readConfig = path => readFile(path, 'utf8'), lookup = lookupCodexShellEnvironment,
  platform = process.platform, home = null } = {}) {
  const childEnv = { ...env };
  if (authMode !== 'cli_login') return childEnv;
  const nativeHome = codexHome || env.CODEX_HOME || join(home ?? getRealHomeDir(), '.codex');
  let providers;
  try { providers = collectCodexProviderEnvKeys(await readConfig(join(nativeHome, 'config.toml'))); }
  catch { providers = new Map(); }
  for (const [id, provider] of Object.entries(config?.model_providers ?? {})) {
    if (provider && Object.hasOwn(provider, 'env_key')) providers.set(id, provider.env_key);
  }
  const names = [...new Set([...providers.values()].filter(isCredentialName))];
  onCredentialNames?.(names);
  const entryName = (source, name) => Object.keys(source).find(key => platform === 'win32'
    ? key.toUpperCase() === name.toUpperCase() : key === name);
  const missing = names.filter(name => {
    if (entryName(childEnv, name) !== undefined) return false;
    const explicit = entryName(baseEnv, name);
    if (explicit === undefined) return true;
    if (typeof baseEnv[explicit] === 'string') {
      Object.defineProperty(childEnv, explicit, { value: baseEnv[explicit], enumerable: true, writable: true, configurable: true });
    }
    return false;
  });
  if (!missing.length) return childEnv;
  try {
    const values = await lookup(missing, baseEnv);
    for (const name of missing) {
      if (typeof values?.[name] === 'string' && values[name]) {
        Object.defineProperty(childEnv, name, { value: values[name], enumerable: true, writable: true, configurable: true });
      }
    }
  } catch { /* native authentication still owns an unavailable credential */ }
  return childEnv;
}
