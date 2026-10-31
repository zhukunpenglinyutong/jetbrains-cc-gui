import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { findUnsafeShellMetacharacter } from './command-validator.js';

const WINDOWS_SHELL_EXTENSIONS = new Set(['.cmd', '.bat']);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.cmd', '.bat', '.exe']);
const WINDOWS_SHELL_COMMANDS = new Set(['npx', 'npm', 'pnpm', 'yarn']);
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const LOOKUP_TIMEOUT_MS = 5000;
const pendingListings = new Map();

/** Windows environment names are case-insensitive (`Path` is common). */
function readEnvValue(env, name) {
  const key = name in env ? name : Object.keys(env).find(item => item.toUpperCase() === name);
  return typeof env[key] === 'string' ? env[key] : '';
}

/**
 * List each PATH directory once. Concurrent lookups share a listing still in
 * flight, so an offline share holds one libuv thread rather than one per server.
 * Store aliases such as WindowsApps\python.exe are links, so keep non-folders.
 */
function listDirectory(directory) {
  const key = directory.toLowerCase();
  if (!pendingListings.has(key)) {
    const listing = readdir(directory, { withFileTypes: true })
      .then(entries => entries.filter(entry => !entry.isDirectory()).map(entry => entry.name), () => [])
      .finally(() => pendingListings.delete(key));
    pendingListings.set(key, listing);
  }
  return pendingListings.get(key);
}

async function searchPath(command, env, list, isCancelled) {
  const extensions = (readEnvValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';')
    .map(extension => extension.trim().toLowerCase())
    .filter(extension => WINDOWS_EXECUTABLE_EXTENSIONS.has(extension));
  // Relative entries would resolve against the bridge directory, so skip them.
  const directories = readEnvValue(env, 'PATH').split(';')
    .map(directory => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(directory => path.win32.isAbsolute(directory));
  for (const directory of directories) {
    if (isCancelled()) return null;
    const names = new Map((await list(directory)).map(name => [name.toLowerCase(), name]));
    const match = extensions.map(extension => names.get(`${command}${extension}`.toLowerCase())).find(Boolean);
    if (match) return path.win32.join(directory, match);
  }
  return null;
}

/**
 * Find the first PATH directory holding the command with a PATHEXT extension.
 * Node's file APIs keep non-ASCII paths intact, unlike where.exe output in the
 * console code page. The bounded wait keeps an offline PATH directory from
 * stalling every MCP verification timer.
 */
export async function findWindowsCommand(command, env = {}, list = listDirectory, timeoutMs = LOOKUP_TIMEOUT_MS) {
  if (/[\\/:]/.test(command)) return null;
  let timedOut = false;
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutMs);
  });
  try {
    return await Promise.race([searchPath(command, env, list, () => timedOut), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve extensionless Windows commands to the executable selected by PATH. */
export async function resolveWindowsCommand(
  command,
  env = process.env,
  platform = process.platform,
  lookup = findWindowsCommand
) {
  if (platform !== 'win32' || typeof command !== 'string') {
    return { command, useShell: false };
  }
  const normalizedCommand = command.trim();
  const extension = path.win32.extname(normalizedCommand).toLowerCase();
  if (WINDOWS_SHELL_EXTENSIONS.has(extension) || extension === '.exe') {
    return { command: normalizedCommand, useShell: WINDOWS_SHELL_EXTENSIONS.has(extension) };
  }
  const resolvedCommand = await lookup(normalizedCommand, env);
  if (resolvedCommand) {
    return {
      command: resolvedCommand,
      useShell: WINDOWS_SHELL_EXTENSIONS.has(path.win32.extname(resolvedCommand).toLowerCase())
    };
  }
  return {
    command: normalizedCommand,
    useShell: WINDOWS_SHELL_COMMANDS.has(normalizedCommand.toLowerCase())
  };
}

/** Node joins shell command/args without quoting; preserve each cmd.exe token. */
export function prepareStdioLaunch(launch, args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('Command args must be strings');
  }
  if (!launch.useShell) return { ...launch, args };
  // Reject expansion/quoting syntax as well as chaining. Validate the resolved
  // path too: it can come from a PATH directory rather than the configuration.
  // Name only the character: arguments often carry credentials.
  const unsafe = [launch.command, ...args].map(findUnsafeShellMetacharacter).find(Boolean);
  if (unsafe) {
    throw new Error(`Command or args contain unsafe shell metacharacter ${JSON.stringify(unsafe)}; `
      + 'pass such values through env instead');
  }
  return { ...launch, command: `"${launch.command}"`, args: args.map(quoteBatchArgument) };
}

/** Double trailing backslashes so argv parsing does not read `\"` as a literal quote. */
function quoteBatchArgument(arg) {
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`;
}
