import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildCliSpawnEnv, decodeCliOutput, resolveCliSpawn, resolveGeminiCliPath } from '../../utils/cli-path.js';
import { killChildTree } from '../../utils/cli-spawn.js';
import { compareSemver, parseSemver } from './agy-binary-verifier.js';

const MIN_VERSION = '1.1.11';
const MAX_OUTPUT_BYTES = 256 * 1024;

function unavailable(reasonCode, extra) {
  return { status: 'unavailable', reasonCode, ...extra };
}

function capture(bin, args, env, timeout) {
  return new Promise((resolve, reject) => {
    const invocation = resolveCliSpawn(bin, args, {
      env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32',
    });
    const child = spawn(invocation.file, invocation.args, invocation.options);
    const chunks = [];
    let size = 0;
    const stop = (code) => {
      clearTimeout(timer);
      killChildTree(child, 'Antigravity quota');
      child.stdout.destroy();
      reject(Object.assign(new Error('Antigravity probe did not finish'), { code }));
    };
    const timer = setTimeout(() => stop('ETIMEDOUT'), timeout);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) stop('ENOBUFS');
      else chunks.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? decodeCliOutput(Buffer.concat(chunks)) : null);
    });
  });
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseUsageOutput(stdout) {
  const whole = parseObject(stdout.trim());
  if (whole) return whole;
  // Some launchers print notices around a single-line result.
  return stdout.trim().split(/\r?\n/).reduce((result, line) => {
    const candidate = line.trimStart().startsWith('{') ? parseObject(line) : null;
    if (candidate?.status !== 'SUCCESS' && candidate?.status !== 'ERROR') return result;
    return candidate.command?.name === 'usage' || typeof candidate.num_turns === 'number' ? candidate : result;
  }, null);
}

/** Run both commands with the same launcher and environment in the bridge's runtime. */
export async function probeAntigravityQuota({ findCli = resolveGeminiCliPath, run = capture } = {}) {
  try {
    const bin = findCli();
    const env = buildCliSpawnEnv(bin);
    // Query only the CLI login, not an API key or custom endpoint inherited from the IDE.
    for (const key of Object.keys(env)) {
      if (/^(GEMINI_API_KEY|GOOGLE_GEMINI_BASE_URL)$/i.test(key)) delete env[key];
    }
    const versionOutput = await run(bin, ['--version'], env, 5_000);
    if (versionOutput === null) return unavailable('query_failed');
    const versions = versionOutput.split(/\r?\n/).map(parseSemver).filter(Boolean);
    const version = versions[0];
    // A version mentioned inside a diagnostic is not proof that /usage is a local command.
    if (versions.length !== 1 || version.prerelease || !(compareSemver(version, MIN_VERSION) >= 0)) {
      return unavailable('cli_outdated', { minimumVersion: MIN_VERSION });
    }

    const stdout = await run(bin, ['--print', '/usage', '--output-format', 'json'], env, 30_000);
    const result = stdout === null ? null : parseUsageOutput(stdout);
    if (result?.status !== 'SUCCESS') return unavailable('query_failed');
    if (result.command?.name === 'usage') return { status: 'SUCCESS', command: result.command };
    if (!result.command && result.num_turns > 0) {
      // A misleading wrapper version can still mask a CLI that treated /usage as a prompt.
      return unavailable('cli_outdated', { minimumVersion: MIN_VERSION, legacyModelTurn: true });
    }
    return unavailable('no_quota');
  } catch (error) {
    return unavailable(error?.code === 'ETIMEDOUT' ? 'timeout' : error?.code === 'ENOENT' ? 'cli_missing' : 'query_failed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(await probeAntigravityQuota()));
}
