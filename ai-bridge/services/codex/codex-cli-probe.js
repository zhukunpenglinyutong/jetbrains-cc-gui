/**
 * Prints the Codex CLI the bridge would start: its path, then its version line.
 *
 * CliStatusDetector runs this when node is a WSL binary. It resolves the CLI
 * inside WSL with the bridge's own logic, so the settings page reports the same
 * install a chat would use and no shell script has to survive wsl.exe quoting.
 * Exits 1 when no candidate starts.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildCliSpawnEnv } from '../../utils/cli-path.js';
import { getCodemossDir, isMainEntryModule } from '../../utils/path-utils.js';
import { resolveCodexCli } from './codex-cli-resolver.js';

const VERSION_TIMEOUT_MS = 5_000;
// A half-installed npm launcher can still be executable; only real version output proves Codex can start.
const VERSION_LINE = /^[ \t]*codex-cli[ \t]+\S+[ \t]*$/m;

const resolveLikeTheDaemon = () => resolveCodexCli({
  depsRoot: join(getCodemossDir(), 'dependencies', 'codex-sdk', 'node_modules'),
  nodePath: process.execPath,
});

function readCodexVersion([file, ...args]) {
  try {
    return execFileSync(file, [...args, '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: VERSION_TIMEOUT_MS,
      env: buildCliSpawnEnv(file),
    });
  } catch {
    return null;
  }
}

/**
 * @param {object} [deps] test hooks
 * @param {() => {candidates?: {command: string[]}[]}} [deps.resolve]
 * @param {(command: string[]) => string|null} [deps.readVersion]
 * @returns {{path: string, versionLine: string}|null}
 */
export function probeCodexCli({ resolve = resolveLikeTheDaemon, readVersion = readCodexVersion } = {}) {
  for (const candidate of resolve().candidates ?? []) {
    const match = VERSION_LINE.exec(readVersion(candidate.command) ?? '');
    if (match) {
      return { path: candidate.command.at(-1), versionLine: match[0].trim() };
    }
  }
  return null;
}

if (isMainEntryModule(import.meta.url)) {
  const found = probeCodexCli();
  if (found) {
    process.stdout.write(`${found.path}\n${found.versionLine}\n`);
  }
  process.exitCode = found ? 0 : 1;
}
