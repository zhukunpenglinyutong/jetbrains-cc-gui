import { looksLikePathSegment } from '../utils/pathSegment';

/** Heuristic that prevents matching bare @mentions without path-like structure. */
function isLikelyFilePath(path: string): boolean {
  return (
    /[\\/]/.test(path) || // has path separator
    /:\/\//.test(path) || // protocol:// (terminal, service)
    /\.[A-Za-z]{2,10}$/.test(path) // has source-file extension (≥2 chars)
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Extract a file path starting after `@` at position `start` in `text`.
 * Returns `[fullMatch, filePath, lineStart?, lineEnd?]` or null.
 *
 * Scans forward character-by-character, allowing spaces inside the path
 * when the next word segment looks like a path continuation (contains
 * a path separator or a file extension).  A trailing `#L10-20` line marker
 * is parsed into separate line-start / line-end groups.
 */
function extractAtFilePath(
  text: string,
  start: number,
): { rawPath: string; lineStart?: number; lineEnd?: number } | null {
  const afterAt = text.slice(start);
  let endPos = 0;
  let lineStart: number | undefined;
  let lineEnd: number | undefined;

  while (endPos < afterAt.length) {
    const ch = afterAt[endPos];
    if (ch === '\n' || ch === '\r' || ch === '@') break;

    if (ch === ' ' || ch === '\t') {
      // Look ahead: does the next word look like a path segment?
      const peekRemainder = afterAt.slice(endPos + 1);
      if (
        peekRemainder.length > 0 &&
        peekRemainder[0] !== ' ' &&
        peekRemainder[0] !== '\t' &&
        peekRemainder[0] !== '\n' &&
        peekRemainder[0] !== '\r' &&
        peekRemainder[0] !== '@' &&
        looksLikePathSegment(peekRemainder.split(/\s/)[0])
      ) {
        endPos++; // space is inside the path
        continue;
      }
      break;
    }

    endPos++;
  }

  let rawPath = afterAt.slice(0, endPos);

  // Detect #L10-20 suffix (display-only line marker, not part of the path).
  // Use lastIndexOf so paths like C:\C#\App.cs are not falsely split.
  const hashIndex = rawPath.lastIndexOf('#');
  if (hashIndex !== -1) {
    const suffix = rawPath.slice(hashIndex);
    const lineMatch = suffix.match(/^#L(\d+)(?:-(\d+))?$/);
    if (lineMatch) {
      lineStart = Number(lineMatch[1]);
      lineEnd = lineMatch[2] !== undefined ? Number(lineMatch[2]) : undefined;
      rawPath = rawPath.slice(0, hashIndex);
    }
  }

  if (!isLikelyFilePath(rawPath)) return null;

  return { rawPath, lineStart, lineEnd };
}

/**
 * Convert @path references into compact clickable `<a>` links at display time.
 *
 * Before: "@C:\Users\Bob\proj\src\app.ts#L10-20"
 * After:  "<a href=... data-linkify=file>@app.ts#L10-20</a>"
 *
 * The href preserves the full absolute path (with :line format for navigation).
 * Protocol layer text sent to the AI is unchanged — this transformation is
 * display-only.
 *
 * @visibleForTesting
 */
export function convertAtFileRefsToLinks(text: string): string {
  if (!text || !text.includes('@')) {
    return escapeHtml(text);
  }

  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] !== '@') {
      result += escapeHtml(text[i]);
      i++;
      continue;
    }

    // Skip @@ (escaped literal @)
    if (i + 1 < text.length && text[i + 1] === '@') {
      result += '@@';
      i += 2;
      continue;
    }

    const extracted = extractAtFilePath(text, i + 1);
    if (!extracted) {
      result += escapeHtml(text[i]);
      i++;
      continue;
    }

    const { rawPath, lineStart, lineEnd } = extracted;
    const fileName = rawPath.split(/[/\\]/).pop() || rawPath;

    // Build display text
    let displayText: string;
    if (lineStart !== undefined) {
      displayText = lineEnd !== undefined
        ? `@${fileName}#L${lineStart}-${lineEnd}`
        : `@${fileName}#L${lineStart}`;
    } else {
      displayText = `@${fileName}`;
    }

    // Build href — use :line format for openFile / parseFileLinkTarget compatibility
    const encodedPath = rawPath.replace(/ /g, '%20');
    let href: string;
    if (lineStart !== undefined) {
      href = lineEnd !== undefined
        ? `${encodedPath}:${lineStart}-${lineEnd}`
        : `${encodedPath}:${lineStart}`;
    } else {
      href = encodedPath;
    }

    result += `<a class="file-link" data-linkify="file" href="${escapeHtml(href)}" title="${escapeHtml(rawPath)}">${escapeHtml(displayText)}</a>`;

    // Advance past the full match: @ + rawPath + optional #L suffix
    i += 1 + extracted.rawPath.length; // skip '@' + rawPath
    if (extracted.lineStart !== undefined) {
      // Skip past the #L marker text in the original
      const marker = extracted.lineEnd !== undefined
        ? `#L${extracted.lineStart}-${lineEnd}`
        : `#L${extracted.lineStart}`;
      i += marker.length;
    }
  }

  return result;
}
