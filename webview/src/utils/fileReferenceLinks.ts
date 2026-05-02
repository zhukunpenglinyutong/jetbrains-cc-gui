import { sendBridgeEvent } from './bridge';

export interface FileReferenceMatch {
  index: number;
  originalText: string;
  pathText: string;
  /** 1-based line number; 0 means open the file without line navigation. */
  line: number;
}

export interface FileReferenceRequest {
  id: string;
  pathText: string;
  /** 1-based line number; 0 means open the file without line navigation. */
  line: number;
  /** Nearby rendered text/code used by the backend to disambiguate duplicate filenames. */
  contextText?: string;
}

export interface FileReferenceResolveResult {
  id: string;
  pathText: string;
  resolvedPath?: string;
  line: number;
  resolved: boolean;
  reason?: string;
}

interface FileReferenceResolvePayload {
  requestId: string;
  results: FileReferenceResolveResult[];
}

const FILE_PATH_SOURCE = String.raw`(?:[A-Za-z]:[\\/])?(?:(?:[A-Za-z0-9_$@.+~-]+)[\\/])*[A-Za-z0-9_$@.+~-]+\.[A-Za-z][A-Za-z0-9]{0,15}`;
const HASH_LINE_SUFFIX_SOURCE = String.raw`#L(\d+)(?:C\d+)?(?:[-–]L?\d+(?:C\d+)?)?`;
const LINE_SUFFIX_SOURCE = String.raw`(?:\s*[:：]\s*(\d+)(?::\d+)?(?:[-–]\d+(?::\d+)?)?|\s*[\(（]\s*(?:(?:lines?|行|第)\s*)?(\d+)(?:\s*[-–]\s*\d+)?\s*(?:行)?\s*[\)）]|\s+lines?\s+(\d+)(?:\s*[-–]\s*\d+)?|\s+行\s*(\d+)(?:\s*[-–]\s*\d+)?|\s+第\s*(\d+)(?:\s*[-–]\s*\d+)?\s*行)`;
const FILE_LINE_REFERENCE_REGEX = new RegExp(`(${FILE_PATH_SOURCE})(?:${HASH_LINE_SUFFIX_SOURCE}|${LINE_SUFFIX_SOURCE})`, 'giu');
const FILE_ONLY_REFERENCE_REGEX = new RegExp(`(${FILE_PATH_SOURCE})`, 'giu');
const ADJACENT_LINE_SUFFIX_REGEX = new RegExp(`^(${LINE_SUFFIX_SOURCE})`, 'iu');
const JAVA_CLASS_NAME_REGEX = /^[A-Z][A-Za-z0-9_$]{2,}$/;
const SOURCE_FILE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'gradle',
  'groovy',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'kts',
  'less',
  'md',
  'php',
  'properties',
  'py',
  'rb',
  'rs',
  'scala',
  'scss',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
  'xml',
  'yaml',
  'yml',
]);

const SKIP_SELECTOR = [
  'pre',
  'a',
  'button',
  '.code-block-wrapper',
  '.mermaid-diagram',
  '.file-reference-link',
  '.file-reference-pending',
].join(',');

const resolveCache = new Map<string, FileReferenceResolveResult>();
const pendingRequests = new Map<string, (results: FileReferenceResolveResult[]) => void>();
const REFERENCE_CONTEXT_BEFORE_CHARS = 1200;
const REFERENCE_CONTEXT_AFTER_CHARS = 6000;

let callbackRegistered = false;
let requestCounter = 0;
let referenceCounter = 0;

export function normalizeFileReferencePath(pathText: string): string {
  return pathText.replace(/\\/g, '/').trim();
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

export function getFileReferenceCacheKey(pathText: string, line: number, contextText = ''): string {
  const normalizedContext = normalizeContextText(contextText);
  const contextKey = normalizedContext ? `:${hashString(normalizedContext)}` : '';
  return `${normalizeFileReferencePath(pathText)}:${line}${contextKey}`;
}

function getFileExtension(pathText: string): string {
  const filename = normalizeFileReferencePath(pathText).split('/').pop() || '';
  const dotIndex = filename.lastIndexOf('.');
  return dotIndex >= 0 ? filename.slice(dotIndex + 1).toLowerCase() : '';
}

function isLikelySourceFilePath(pathText: string): boolean {
  const normalized = normalizeFileReferencePath(pathText);
  return SOURCE_FILE_EXTENSIONS.has(getFileExtension(normalized));
}

function parseLineNumber(match: RegExpExecArray, startIndex = 2): number | null {
  for (let i = startIndex; i < match.length; i += 1) {
    const value = match[i];
    if (value) {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
  }
  return null;
}

function isMatchInsideUrl(text: string, matchIndex: number): boolean {
  const tokenStart = Math.max(
    text.lastIndexOf(' ', matchIndex),
    text.lastIndexOf('\n', matchIndex),
    text.lastIndexOf('\t', matchIndex),
    text.lastIndexOf('(', matchIndex),
    text.lastIndexOf('（', matchIndex),
  ) + 1;
  const prefix = text.slice(tokenStart, matchIndex);
  return /(?:https?|file):\/\//i.test(prefix);
}

export function findFileReferenceMatches(text: string): FileReferenceMatch[] {
  const matches: FileReferenceMatch[] = [];
  const occupiedRanges: Array<{ start: number; end: number }> = [];

  let match: RegExpExecArray | null;
  FILE_LINE_REFERENCE_REGEX.lastIndex = 0;
  while ((match = FILE_LINE_REFERENCE_REGEX.exec(text)) !== null) {
    const pathText = match[1];
    const line = parseLineNumber(match);

    if (!pathText || line === null || isMatchInsideUrl(text, match.index)) {
      continue;
    }

    matches.push({
      index: match.index,
      originalText: match[0],
      pathText,
      line,
    });
    occupiedRanges.push({ start: match.index, end: match.index + match[0].length });
  }

  FILE_ONLY_REFERENCE_REGEX.lastIndex = 0;
  while ((match = FILE_ONLY_REFERENCE_REGEX.exec(text)) !== null) {
    const pathText = match[1];
    const start = match.index;
    const end = start + match[0].length;

    if (
      !pathText
      || !isLikelySourceFilePath(pathText)
      || isMatchInsideUrl(text, start)
      || occupiedRanges.some((range) => start < range.end && end > range.start)
    ) {
      continue;
    }

    matches.push({
      index: start,
      originalText: match[0],
      pathText,
      line: 0,
    });
    occupiedRanges.push({ start, end });
  }

  return matches.sort((a, b) => a.index - b.index);
}

function ensureResolveCallbackRegistered(): void {
  if (callbackRegistered || typeof window === 'undefined') {
    return;
  }

  window.onFileReferenceResolveResult = (payload: string) => {
    try {
      const data = JSON.parse(payload) as FileReferenceResolvePayload;
      const handler = pendingRequests.get(data.requestId);
      if (!handler) {
        return;
      }
      pendingRequests.delete(data.requestId);
      handler(Array.isArray(data.results) ? data.results : []);
    } catch {
      // Ignore malformed bridge payloads; leaving pending spans is safer than
      // throwing inside a global WebView callback.
    }
  };

  callbackRegistered = true;
}

function createRequestId(): string {
  requestCounter += 1;
  return `file-ref-${Date.now()}-${requestCounter}`;
}

function createReferenceId(): string {
  referenceCounter += 1;
  return `ref-${Date.now()}-${referenceCounter}`;
}

function createPendingSpan(match: FileReferenceMatch): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'file-reference-pending';
  span.dataset.fileRefId = createReferenceId();
  span.dataset.originalText = match.originalText;
  span.dataset.pathText = match.pathText;
  span.dataset.line = String(match.line);
  span.textContent = match.originalText;
  return span;
}

function createResolvedLink(span: HTMLElement, result: FileReferenceResolveResult): HTMLAnchorElement {
  const originalText = span.dataset.originalText || span.textContent || result.pathText;
  const resolvedPath = result.resolvedPath || '';
  const line = result.line || Number.parseInt(span.dataset.line || '0', 10);

  const link = document.createElement('a');
  link.className = 'file-reference-link';
  link.href = line > 0 ? `${resolvedPath}:${line}` : resolvedPath;
  link.title = line > 0 ? `${resolvedPath} (line ${line})` : resolvedPath;
  link.dataset.resolvedPath = resolvedPath;
  link.dataset.line = String(line);
  link.textContent = originalText;
  return link;
}

function replaceSpanWithResolvedLink(span: HTMLElement, result: FileReferenceResolveResult): void {
  const link = createResolvedLink(span, result);
  const parent = span.parentElement;

  if (
    parent?.tagName === 'CODE'
    && parent.parentElement?.tagName !== 'PRE'
    && parent.textContent === span.textContent
  ) {
    parent.replaceWith(link);
    return;
  }

  span.replaceWith(link);
}

function restoreOriginalText(span: HTMLElement): void {
  span.replaceWith(document.createTextNode(span.dataset.originalText || span.textContent || ''));
}

function patchSpansForResult(
  container: HTMLElement,
  result: FileReferenceResolveResult,
  cacheKey = getFileReferenceCacheKey(result.pathText, result.line),
): void {
  const spans = Array.from(container.querySelectorAll<HTMLElement>('.file-reference-pending'));

  for (const span of spans) {
    if (span.dataset.fileRefId !== result.id && span.dataset.cacheKey !== cacheKey) {
      continue;
    }

    if (result.resolved && result.resolvedPath) {
      replaceSpanWithResolvedLink(span, result);
    } else {
      restoreOriginalText(span);
    }
  }
}

function applyCachedResult(container: HTMLElement, span: HTMLSpanElement): boolean {
  const cacheKey = span.dataset.cacheKey;
  if (!cacheKey) {
    return false;
  }

  const cached = resolveCache.get(cacheKey);
  if (!cached) {
    return false;
  }

  patchSpansForResult(container, cached, cacheKey);
  return true;
}

function findFirstTextNode(node: Node): Text | null {
  if (node instanceof Text) {
    return node;
  }

  let child = node.firstChild;
  while (child) {
    const text = findFirstTextNode(child);
    if (text) {
      return text;
    }
    child = child.nextSibling;
  }

  return null;
}

function findLastTextNode(node: Node): Text | null {
  if (node instanceof Text) {
    return node;
  }

  let child = node.lastChild;
  while (child) {
    const text = findLastTextNode(child);
    if (text) {
      return text;
    }
    child = child.previousSibling;
  }

  return null;
}

function findNextTextNodeAfter(node: Node, root: HTMLElement): Text | null {
  let current: Node | null = node;

  while (current && current !== root) {
    let sibling = current.nextSibling;
    while (sibling) {
      const text = findFirstTextNode(sibling);
      if (text) {
        return text;
      }
      sibling = sibling.nextSibling;
    }
    current = current.parentNode;
  }

  return null;
}

function findPreviousTextNodeBefore(node: Node, root: HTMLElement): Text | null {
  let current: Node | null = node;

  while (current && current !== root) {
    let sibling = current.previousSibling;
    while (sibling) {
      const text = findLastTextNode(sibling);
      if (text) {
        return text;
      }
      sibling = sibling.previousSibling;
    }
    current = current.parentNode;
  }

  return null;
}

function collectNextText(node: Node, root: HTMLElement, maxChars: number): string {
  const parts: string[] = [];
  let current: Node | null = node;
  let total = 0;

  while (current && total < maxChars) {
    const textNode = findNextTextNodeAfter(current, root);
    if (!textNode) {
      break;
    }
    const value = textNode.nodeValue || '';
    if (value) {
      parts.push(value);
      total += value.length;
    }
    current = textNode;
  }

  return parts.join('').slice(0, maxChars);
}

function collectPreviousText(node: Node, root: HTMLElement, maxChars: number): string {
  const parts: string[] = [];
  let current: Node | null = node;
  let total = 0;

  while (current && total < maxChars) {
    const textNode = findPreviousTextNodeBefore(current, root);
    if (!textNode) {
      break;
    }
    const value = textNode.nodeValue || '';
    if (value) {
      parts.unshift(value);
      total += value.length;
    }
    current = textNode;
  }

  return parts.join('').slice(-maxChars);
}

function normalizeContextText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildReferenceContext(container: HTMLElement, span: HTMLElement): string {
  const before = collectPreviousText(span, container, REFERENCE_CONTEXT_BEFORE_CHARS);
  const current = span.textContent || '';
  const after = collectNextText(span, container, REFERENCE_CONTEXT_AFTER_CHARS);
  return normalizeContextText(`${before} ${current} ${after}`);
}

function consumeAdjacentLineSuffix(container: HTMLElement, span: HTMLSpanElement): void {
  const currentLine = Number.parseInt(span.dataset.line || '', 10);
  const pathText = span.dataset.pathText;
  if (!pathText || currentLine !== 0) {
    return;
  }

  const textNode = findNextTextNodeAfter(span, container);
  const text = textNode?.nodeValue || '';
  const match = ADJACENT_LINE_SUFFIX_REGEX.exec(text);
  if (!textNode || !match) {
    return;
  }

  const line = parseLineNumber(match, 2);
  if (line === null) {
    return;
  }

  const suffix = match[0];
  const originalText = span.dataset.originalText || span.textContent || pathText;
  const combinedText = `${originalText}${suffix}`;

  span.dataset.line = String(line);
  span.dataset.originalText = combinedText;
  span.textContent = combinedText;

  textNode.nodeValue = text.slice(suffix.length);
  if (textNode.nodeValue.length === 0) {
    textNode.parentNode?.removeChild(textNode);
  }
}

function shouldSkipInlineCodeElement(code: HTMLElement): boolean {
  return Boolean(code.closest([
    'pre',
    'a',
    'button',
    '.code-block-wrapper',
    '.file-reference-link',
    '.file-reference-pending',
  ].join(',')));
}

function collectInlineCodeJavaClassReferences(container: HTMLElement): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = [];
  const codeElements = Array.from(container.querySelectorAll<HTMLElement>('code'));

  for (const code of codeElements) {
    if (shouldSkipInlineCodeElement(code) || code.childElementCount > 0) {
      continue;
    }

    const className = (code.textContent || '').trim();
    if (!JAVA_CLASS_NAME_REGEX.test(className)) {
      continue;
    }

    const nextText = findNextTextNodeAfter(code, container)?.nodeValue || '';
    if (!ADJACENT_LINE_SUFFIX_REGEX.test(nextText)) {
      continue;
    }

    const span = createPendingSpan({
      index: 0,
      originalText: className,
      pathText: `${className}.java`,
      line: 0,
    });
    code.textContent = '';
    code.appendChild(span);
    spans.push(span);
  }

  return spans;
}

function shouldSkipTextNode(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || !node.nodeValue || !node.nodeValue.trim()) {
    return true;
  }
  return Boolean(parent.closest(SKIP_SELECTOR));
}

function collectTextNodes(container: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();

  while (current) {
    if (current instanceof Text && !shouldSkipTextNode(current)) {
      nodes.push(current);
    }
    current = walker.nextNode();
  }

  return nodes;
}

function replaceTextNodeWithPendingSpans(node: Text): HTMLSpanElement[] {
  const text = node.nodeValue || '';
  const matches = findFileReferenceMatches(text);
  if (matches.length === 0 || !node.parentNode) {
    return [];
  }

  const fragment = document.createDocumentFragment();
  const spans: HTMLSpanElement[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.index < cursor) {
      continue;
    }

    if (match.index > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    }

    const span = createPendingSpan(match);
    fragment.appendChild(span);
    spans.push(span);
    cursor = match.index + match.originalText.length;
  }

  if (cursor < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(cursor)));
  }

  node.parentNode.replaceChild(fragment, node);

  return spans.filter((span) => span.isConnected && span.classList.contains('file-reference-pending'));
}

function requestFileReferenceResolution(
  references: FileReferenceRequest[],
  onResults: (results: FileReferenceResolveResult[]) => void,
): () => void {
  if (references.length === 0) {
    return () => {};
  }

  ensureResolveCallbackRegistered();

  const requestId = createRequestId();
  pendingRequests.set(requestId, onResults);

  const sent = sendBridgeEvent('resolve_file_references', JSON.stringify({ requestId, references }));
  if (!sent) {
    pendingRequests.delete(requestId);
    queueMicrotask(() => {
      onResults(references.map((reference) => ({
        ...reference,
        resolved: false,
        reason: 'bridge_unavailable',
      })));
    });
  }

  return () => {
    pendingRequests.delete(requestId);
  };
}

export function decorateFileReferences(container: HTMLElement | null): () => void {
  if (!container) {
    return () => {};
  }

  const pendingSpans = collectTextNodes(container)
    .flatMap((node) => replaceTextNodeWithPendingSpans(node));
  pendingSpans.push(...collectInlineCodeJavaClassReferences(container));

  for (const span of pendingSpans) {
    consumeAdjacentLineSuffix(container, span);
  }

  for (const span of pendingSpans) {
    const pathText = span.dataset.pathText;
    const line = Number.parseInt(span.dataset.line || '', 10);
    if (!pathText || !Number.isFinite(line) || line < 0) {
      continue;
    }
    const contextText = buildReferenceContext(container, span);
    span.dataset.contextText = contextText;
    span.dataset.cacheKey = getFileReferenceCacheKey(pathText, line, contextText);
  }

  for (const span of pendingSpans) {
    applyCachedResult(container, span);
  }

  const referencesByCacheKey = new Map<string, FileReferenceRequest>();
  for (const span of pendingSpans) {
    const pathText = span.dataset.pathText;
    const line = Number.parseInt(span.dataset.line || '', 10);
    const cacheKey = span.dataset.cacheKey;

    if (!pathText || !cacheKey || !Number.isFinite(line) || line < 0 || resolveCache.has(cacheKey)) {
      continue;
    }

    referencesByCacheKey.set(cacheKey, {
      id: span.dataset.fileRefId || createReferenceId(),
      pathText,
      line,
      contextText: span.dataset.contextText || '',
    });
  }

  const requests = Array.from(referencesByCacheKey.values());
  const requestById = new Map(requests.map((request) => [request.id, request]));

  return requestFileReferenceResolution(requests, (results) => {
    for (const result of results) {
      const request = requestById.get(result.id);
      const cacheKey = request
        ? getFileReferenceCacheKey(request.pathText, request.line, request.contextText || '')
        : getFileReferenceCacheKey(result.pathText, result.line);
      resolveCache.set(cacheKey, result);
      patchSpansForResult(container, result, cacheKey);
    }
  });
}

export function resetFileReferenceResolutionForTests(): void {
  resolveCache.clear();
  pendingRequests.clear();
  callbackRegistered = false;
  requestCounter = 0;
  referenceCounter = 0;
  if (typeof window !== 'undefined') {
    delete window.onFileReferenceResolveResult;
  }
}
