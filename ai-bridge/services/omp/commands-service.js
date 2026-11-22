/**
 * Discover OMP slash commands through `omp --mode rpc` (`get_available_commands`).
 * The catalog is per working directory: project skills, custom commands and
 * extensions are resolved by omp relative to the directory it starts in.
 */

import { homedir } from 'os';
import {
  commonCliBinDirs,
  enrichPathWithBinDirs,
  resolveOmpCliPath,
} from '../../utils/cli-path.js';
import { OmpRpcClient } from './rpc-client.js';

const RPC_ARGS = ['--mode', 'rpc', '--no-ui', '--no-session'];
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;
const CLOSE_GRACE_MS = 2_000;

/**
 * Map the `data` of a `get_available_commands` response to plugin entries.
 * Never throws: anything that is not a command array yields an empty list.
 *
 * @param {unknown} data response data, `{ commands: [...] }`
 * @returns {{ name: string, description: string, argumentHint: string, source: string }[]}
 */
export function mapOmpCommands(data) {
  const raw = data && typeof data === 'object' ? data.commands : null;
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const commands = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue;
    // The plugin prepends the slash itself; omp names are bare but tolerate a prefix.
    const name = entry.name.replace(/^\/+/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const hint = entry.input && typeof entry.input === 'object' ? entry.input.hint : '';
    commands.push({
      name,
      description: typeof entry.description === 'string' ? entry.description : '',
      argumentHint: typeof hint === 'string' ? hint : '',
      source: typeof entry.source === 'string' ? entry.source : '',
    });
  }
  return commands;
}

function describeFailure(error, { bin, cwd }) {
  if (error?.code === 'ENOENT') {
    return `OMP CLI not found or working directory missing (bin: ${bin}, cwd: ${cwd}). `
      + 'Install omp and ensure it is on PATH (or set OMP_BIN).';
  }
  return error?.message || String(error);
}

/**
 * Print `{ success, commands }` for the working directory. Never throws.
 *
 * @param {{ cwd?: string }} options
 * @param {{ createClient?: (options: object) => object }} [deps] test seam for the RPC client
 */
export async function listCommands({ cwd } = {}, deps = {}) {
  const createClient = deps.createClient || ((options) => new OmpRpcClient(options));
  const workDir = cwd || process.cwd();
  let bin = 'omp';
  let client = null;

  try {
    bin = resolveOmpCliPath();
    const env = { ...process.env };
    enrichPathWithBinDirs(env, commonCliBinDirs(homedir()));

    client = createClient({ bin, args: RPC_ARGS, cwd: workDir, env });
    await client.start({ timeoutMs: START_TIMEOUT_MS });
    const data = await client.request({ type: 'get_available_commands' }, { timeoutMs: REQUEST_TIMEOUT_MS });
    console.log(JSON.stringify({ success: true, commands: mapOmpCommands(data) }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: describeFailure(error, { bin, cwd: workDir }),
      commands: [],
    }));
  } finally {
    if (client) {
      try {
        await client.close({ graceMs: CLOSE_GRACE_MS });
      } catch (closeError) {
        console.error('[OMP] Failed to close RPC client:', closeError?.message || closeError);
      }
    }
  }
}
