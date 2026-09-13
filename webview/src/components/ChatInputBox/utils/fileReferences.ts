/**
 * Shared parsing and registration helpers for absolute file references.
 *
 * A file reference is deliberately stricter than an arbitrary token that
 * happens to start with `@`. Callers must register the complete path before
 * `useFileTags` is allowed to render it as a file tag.
 */

export type FilePathMapping = Map<string, string>;

const ABSOLUTE_FILE_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/\r\n]+[\\/][^\\/\r\n]+|\/)/;
const NEXT_EXPLICIT_REFERENCE_PATTERN = /\s+@(?=(?:[a-zA-Z]:[\\/]|\\\\|\/))/g;
const LINE_REFERENCE_PATTERN = /^@(.+)#L(\d+)(?:-(\d+))?$/;
const COMMON_EXTENSIONLESS_FILE_NAMES = new Set([
  'dockerfile',
  'gemfile',
  'license',
  'makefile',
  'procfile',
  'readme',
]);

/**
 * Normalize one absolute path, accepting an optional leading `@` for text
 * payloads. Newlines are rejected; an `@` inside a structured path remains a
 * valid filename character. Text parsers apply their own stricter marker rule.
 */
export function normalizeAbsoluteFilePath(input: string): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  const path = trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed;
  if (!path || /[\r\n]/.test(path)) return null;
  return ABSOLUTE_FILE_PATH_PATTERN.test(path) ? path : null;
}

function getFileName(filePath: string): string {
  const withoutTrailingSeparators = filePath.replace(/[\\/]+$/, '');
  return withoutTrailingSeparators.split(/[/\\]/).pop() || withoutTrailingSeparators;
}

/**
 * Clipboard text has no structured end marker for a path with spaces. Keep
 * promotion conservative by requiring a filename-like final segment. This
 * accepts normal extensions and common extensionless project files while
 * rejecting typical mixed payloads such as `@C:\\view.xml please review`.
 */
function isPlausiblePastedFilePath(filePath: string): boolean {
  const fileName = getFileName(filePath);
  if (!fileName) return false;

  const lastDot = fileName.lastIndexOf('.');
  if (lastDot >= 0 && lastDot < fileName.length - 1) {
    return !/\s/.test(fileName.slice(lastDot + 1));
  }

  return COMMON_EXTENSIONLESS_FILE_NAMES.has(fileName.toLowerCase());
}

/**
 * Register both the complete path and its display name for exact tag lookup.
 * Returns the normalized path when registration succeeds.
 */
export function registerAbsoluteFileReference(
  pathMapping: FilePathMapping,
  input: string,
): string | null {
  const filePath = normalizeAbsoluteFilePath(input);
  if (!filePath) return null;

  pathMapping.set(filePath, filePath);
  const fileName = getFileName(filePath);
  if (fileName) {
    pathMapping.set(fileName, filePath);
  }
  return filePath;
}

/**
 * Parse a complete clipboard payload made only of explicit `@` absolute
 * references. A following `@` that starts another absolute path is the only
 * path separator that is inferred; all other text makes the payload invalid.
 */
export function parseExplicitFileReferences(input: string): string[] | null {
  if (typeof input !== 'string') return null;

  const text = input.trim();
  if (!text || !text.startsWith('@')) return null;

  const starts = [0];
  for (const match of text.matchAll(NEXT_EXPLICIT_REFERENCE_PATTERN)) {
    starts.push(match.index + match[0].length - 1);
  }

  const paths: string[] = [];
  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const end = starts[index + 1] ?? text.length;
    const rawPath = text.slice(start + 1, end).trim();

    // A nested @ or a newline inside a segment means this is mixed/ordinary
    // text, not a sequence of explicit file references.
    if (!rawPath || rawPath.includes('@') || /[\r\n]/.test(rawPath)) {
      return null;
    }

    const filePath = normalizeAbsoluteFilePath(rawPath);
    if (!filePath || !isPlausiblePastedFilePath(filePath)) return null;
    paths.push(filePath);
  }

  return paths.length > 0 ? paths : null;
}

export interface LineFileReference {
  path: string;
  reference: string;
}

/**
 * Parse only the strict single-reference form used by editor selections:
 * `@<absolute path>#L<start>` or `@<absolute path>#L<start>-<end>`.
 */
export function parseLineFileReference(input: string): LineFileReference | null {
  if (typeof input !== 'string') return null;

  const match = input.trim().match(LINE_REFERENCE_PATTERN);
  if (!match) return null;

  const path = normalizeAbsoluteFilePath(match[1]);
  if (!path) return null;

  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : undefined;
  if (
    !Number.isSafeInteger(startLine)
    || startLine < 1
    || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < startLine))
  ) {
    return null;
  }

  return {
    path,
    reference: `${path}#L${startLine}${endLine === undefined ? '' : `-${endLine}`}`,
  };
}

/** Register a strict line-number reference and its underlying absolute path. */
export function registerLineFileReference(
  pathMapping: FilePathMapping,
  input: string,
): string | null {
  const parsed = parseLineFileReference(input);
  if (!parsed) return null;

  registerAbsoluteFileReference(pathMapping, parsed.path);
  pathMapping.set(parsed.reference, parsed.path);
  return parsed.reference;
}
