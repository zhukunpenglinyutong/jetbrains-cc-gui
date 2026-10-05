import { spawnSync } from 'node:child_process';
import path from 'node:path';

const WINDOWS_SHELL_EXTENSIONS = new Set(['.cmd', '.bat']);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.cmd', '.bat', '.exe']);
const WINDOWS_SHELL_COMMANDS = new Set(['npx', 'npm', 'pnpm', 'yarn']);

function findWindowsCommand(command, env) {
  const lookupNames = [command];
  const extension = path.win32.extname(command).toLowerCase();
  const looksLikePath = command.includes('\\') || command.includes('/');
  if (!extension) {
    lookupNames.push(`${command}.exe`, `${command}.cmd`, `${command}.bat`);
  }

  const matches = new Set();
  for (const lookupName of lookupNames) {
    const result = spawnSync('where.exe', [lookupName], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      // A hung lookup must not block the event loop; on timeout status is
      // null and the candidate is skipped below.
      timeout: 5000
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') {
      continue;
    }
    for (const candidate of result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)) {
      if (!looksLikePath || candidate.toLowerCase().startsWith(command.toLowerCase())) {
        matches.add(candidate);
      }
    }
  }
  return [...matches];
}

/**
 * Resolve a Windows command to an executable shim that Node can launch.
 * Node does not reliably resolve extensionless commands such as `codegraph`
 * to their `.cmd` shim when using child_process.spawn without a shell.
 *
 * @param {string} command - Configured command
 * @param {Object} env - Child process environment
 * @param {string} platform - Runtime platform, injectable for tests
 * @param {(command: string, env: Object) => string[]} lookup - PATH lookup
 * @returns {{ command: string, useShell: boolean }} Launch command details
 */
export function resolveWindowsCommand(
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
  if (WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    return { command: normalizedCommand, useShell: true };
  }
  if (extension === '.exe') {
    return { command: normalizedCommand, useShell: false };
  }

  const candidates = lookup(normalizedCommand, env);
  const resolvedCommand = candidates.find((candidate) => {
    const candidateExtension = path.win32.extname(candidate).toLowerCase();
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(candidateExtension);
  });

  if (resolvedCommand) {
    const resolvedExtension = path.win32.extname(resolvedCommand).toLowerCase();
    return {
      command: resolvedCommand,
      useShell: WINDOWS_SHELL_EXTENSIONS.has(resolvedExtension)
    };
  }

  return {
    command: normalizedCommand,
    useShell: WINDOWS_SHELL_COMMANDS.has(normalizedCommand.toLowerCase())
  };
}
