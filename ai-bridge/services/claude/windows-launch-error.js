const ENTRYPOINT_NOT_FOUND_CODES = new Set([3221225785, -1073741511]);
const EXIT_CODE_PATTERN = /process exited with code\s+(-?\d+)/i;

/**
 * Explains a Claude Code launch that Windows rejected with STATUS_ENTRYPOINT_NOT_FOUND
 * (0xC0000139). Newer Claude Code builds import ClosePseudoConsole, which only exists
 * on Windows 10 1809 and later, so the CLI fails before it prints anything. Returns
 * null for every other failure.
 */
export function describeClaudeLaunchFailure(message, platform = process.platform) {
  if (platform !== 'win32' || typeof message !== 'string') {
    return null;
  }
  const match = EXIT_CODE_PATTERN.exec(message);
  if (!match || !ENTRYPOINT_NOT_FOUND_CODES.has(Number(match[1]))) {
    return null;
  }
  return 'Claude Code could not start: Windows reported 0xC0000139 (a required system API was not found). '
    + 'Newer Claude Code versions need Windows 10 version 1809 or later (ClosePseudoConsole). '
    + 'Update Windows, or select Claude Agent SDK 2.0.x in Settings → Dependencies.';
}
