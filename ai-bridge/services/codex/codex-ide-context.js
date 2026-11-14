/** Keep editor state out of native user messages whenever the CLI supports it. */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildCliSpawnEnv, resolveCliSpawn } from '../../utils/cli-path.js';

const runFile = promisify(execFile);

/** Probe the selected executable without starting a thread or risking a repeated send. */
export async function sniffForContextSupport({ command, cwd, env }, run = runFile) {
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'codemoss-codex-schema-'));
    const launch = resolveCliSpawn(command[0], [...command.slice(1), 'app-server',
      'generate-json-schema', '--out', directory, '--experimental'], {
      cwd: cwd || undefined, env: buildCliSpawnEnv(command[0], undefined, env),
      timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true,
    });
    await run(launch.file, launch.args, launch.options);
    const schema = JSON.parse(await readFile(join(directory, 'v2', 'TurnStartParams.json'), 'utf8'));
    return Object.hasOwn(schema.properties ?? {}, 'additionalContext');
  } catch {
    // Missing schema commands and probe failures use the interoperable text envelope.
    return false;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

/** Preserve media ordering and user text when an older CLI needs the desktop envelope. */
export function dressContextForTurn(input, additionalContext, supported) {
  if (supported) return { input, additionalContext };
  const context = Object.values(additionalContext ?? {}).map(entry => entry.value).filter(Boolean).join('\n\n');
  if (!context) return { input };
  const prefix = `# Context from my IDE setup:\n\n${context.trim()}\n\n## My request for Codex:\n`;
  const items = structuredClone(input);
  const text = items.find(item => item.type === 'text');
  if (text) {
    text.text = prefix + text.text;
    // Native text element offsets count UTF-8 bytes, not JavaScript characters.
    for (const element of text.text_elements ?? []) {
      element.byteRange.start += Buffer.byteLength(prefix);
      element.byteRange.end += Buffer.byteLength(prefix);
    }
  } else {
    items.unshift({ type: 'text', text: prefix });
  }
  return { input: items };
}
