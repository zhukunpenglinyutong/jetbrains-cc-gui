import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { memo, useMemo, useState, useRef, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import katex from 'katex';
import markedKatex from 'marked-katex-extension';
import {
  captureRangeOffsets,
  restoreRangeOffsets,
  type TextSelectionOffsets,
} from '../utils/selectionOffsets';
import { useMarkdownFileLinkTooltip } from '../hooks/useMarkdownFileLinkTooltip';
import {
  decorateExistingAnchors,
  linkifyHtml,
} from '../utils/linkify';
import {
  getLinkifyCapabilities,
  subscribeLinkifyCapabilities,
  type LinkifyCapabilities,
} from '../utils/linkifyCapabilities';
import { useMermaidDiagrams } from './MarkdownBlock/useMermaidDiagrams';
import { useMarkdownClickHandler } from './MarkdownBlock/useMarkdownClickHandler';
import { ImagePreviewOverlay } from './MarkdownBlock/ImagePreviewOverlay';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github-dark.css';
import 'katex/dist/katex.css';
import { markedHighlight } from 'marked-highlight';

const SAFE_HREF_PROTOCOL_REGEX = /^(?:https?|mailto):/i;
const FILE_URI_SCHEME_REGEX = /^file:/i;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
let hrefSanitizerHookInstalled = false;
const LATEX_CODE_LANGUAGES = new Set(['latex', 'tex', 'math']);

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) {
      return true;
    }
  }
  return false;
}

function isAllowedHrefValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  // Reject hrefs containing C0 control characters (Tab/LF/CR/etc.). They can
  // split the scheme checks below, yet a browser strips those characters from
  // the URL and then executes the underlying scheme (e.g. `java<Tab>script:`
  // resolves to `javascript:`). See MarkdownBlock.test.tsx regression guard.
  if (containsControlCharacter(trimmed)) {
    return false;
  }

  if (WINDOWS_DRIVE_PATH_REGEX.test(trimmed)) {
    return true;
  }

  if (FILE_URI_SCHEME_REGEX.test(trimmed)) {
    return true;
  }

  if (!URI_SCHEME_REGEX.test(trimmed)) {
    return true;
  }

  return SAFE_HREF_PROTOCOL_REGEX.test(trimmed);
}

function ensureSafeHrefSanitizerHook(): void {
  if (hrefSanitizerHookInstalled) {
    return;
  }

  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'href' || typeof data.attrValue !== 'string') {
      return;
    }

    if (isAllowedHrefValue(data.attrValue)) {
      data.forceKeepAttr = true;
      return;
    }

    data.keepAttr = false;
  });

  hrefSanitizerHookInstalled = true;
}

ensureSafeHrefSanitizerHook();

const MARKDOWN_LINK_SANITIZE_OPTIONS = {
  ALLOW_UNKNOWN_PROTOCOLS: true,
} as const;

const highlightLanguages: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
  ['bash', bash],
  ['css', css],
  ['diff', diff],
  ['dockerfile', dockerfile],
  ['go', go],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['kotlin', kotlin],
  ['markdown', markdown],
  ['plaintext', plaintext],
  ['python', python],
  ['rust', rust],
  ['shell', shell],
  ['sql', sql],
  ['typescript', typescript],
  ['xml', xml],
  ['yaml', yaml],
];

highlightLanguages.forEach(([name, language]) => {
  hljs.registerLanguage(name, language);
});

hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['html', 'xhtml', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

// Configure marked to use syntax highlighting
marked.use(
  markedKatex({
    throwOnError: false,
  }),
  markedHighlight({
    highlight(code: string, lang: string) {
      // Skip syntax highlighting for mermaid code blocks
      if (lang === 'mermaid') {
        return code;
      }
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang }).value;
        } catch {
          // Silently fall through to plain-text rendering
        }
      }
      // highlightAuto misclassifies prose like commit messages (leading "- " lines
      // score as diff deletions), so unlabeled blocks render as plain text
      return hljs.highlight(code, { language: 'plaintext' }).value;
    },
  })
);

marked.setOptions({
  breaks: false,
  gfm: true,
});

interface MarkdownBlockProps {
  content?: unknown;
  isStreaming?: boolean;
}

function safeStringifyContent(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = safeStringifyContent(item);
      return text ? [text] : [];
    }).join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return record.text;
    }
    if (typeof record.content === 'string') {
      return record.content;
    }
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Stream-safe processing: handle unclosed code blocks and other markdown structures.
 * During streaming, code blocks may be truncated, causing markdown parsing errors.
 * This function detects and temporarily closes incomplete code blocks.
 */
function makeStreamSafe(content: string): string {
  if (!content) return content;

  let result = content;

  // Handle code blocks: detect unclosed fenced code blocks (```)
  // Track code block state using a state machine approach
  const lines = result.split('\n');
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    // Detect code block opening or closing
    if (trimmedLine.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
  }

  // If still inside a code block, append a closing fence
  if (inCodeBlock) {
    result = result + '\n```';
  }

  // Handle inline code: detect unclosed inline code (`)
  // Only process the last line to avoid affecting multiline structures
  const lastNewlineIndex = result.lastIndexOf('\n');
  const lastLine = lastNewlineIndex >= 0 ? result.slice(lastNewlineIndex + 1) : result;

  // Count single backticks in the last line (excluding double and triple backticks)
  const singleBacktickMatches = lastLine.match(/(?<!`)`(?!`)/g);
  if (singleBacktickMatches && singleBacktickMatches.length % 2 !== 0) {
    result = result + '`';
  }

  return result;
}

/**
 * Split markdown into top-level blocks for block-memoized streaming rendering.
 * Blocks split on blank lines, but never inside fenced code blocks (``` / ~~~)
 * or display-math blocks ($$...$$ / \[...\]), whose contents may legitimately
 * contain blank lines. During streaming every block except the last is stable,
 * so each block's rendered HTML can be memoized by its source text — per-token
 * work drops from O(document) to O(last block).
 */
function splitMarkdownBlocks(content: string): string[] {
  if (!content) return [];

  const lines = content.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  let inDisplayMath = false;
  let mathCloser = '';

  const flush = () => {
    if (current.length > 0) {
      blocks.push(current.join('\n'));
      current = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (inFence) {
      current.push(line);
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }

    if (inDisplayMath) {
      current.push(line);
      if (trimmed === mathCloser) {
        inDisplayMath = false;
      }
      continue;
    }

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
      current.push(line);
      continue;
    }

    if (trimmed === '$$' || trimmed === '\\[') {
      inDisplayMath = true;
      mathCloser = trimmed === '$$' ? '$$' : '\\]';
      current.push(line);
      continue;
    }

    if (trimmed === '') {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return blocks;
}

/**
 * Strip system-internal XML tags injected by Claude Code's prompt protocol.
 * Mirrors `stripPromptXMLTags` from the CLI source (src/utils/messages.ts).
 */
const SYSTEM_XML_TAGS_RE =
  /<(commit_analysis|context|function_analysis|pr_analysis)>[\s\S]*?<\/\1>\n?/g;

function stripSystemTags(content: string): string {
  const result = content.replace(SYSTEM_XML_TAGS_RE, '');
  return result !== content ? result.trim() : result;
}

/**
 * Escape XML/HTML-like tags in prose text so they are rendered as literal text
 * rather than being parsed as DOM elements by the browser.
 * Matches opening <tag>, closing </tag>, self-closing <tag/>, and <!-- comments -->.
 * Does NOT touch content inside code fences (caller responsibility).
 */
const XML_TAG_RE = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;

function escapeXmlTags(text: string): string {
  return text.replace(XML_TAG_RE, (match) =>
    match.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
}

/**
 * Strip system XML tags and escape remaining XML tags only in prose segments
 * (outside fenced code blocks and inline code). Preserves code content as-is
 * so marked can handle XML tags inside code naturally (auto-escape).
 */
const CODE_FENCE_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_RE = /(`[^`\n]+`)/g;
const DISPLAY_MATH_DELIMITER_LINE_RE = /^([ \t]*)\$\$\s*$/;
const BRACKET_MATH_DELIMITER_RE = /(?<!\\)(\\\[|\\\]|\\\(|\\\))/g;
const BRACKET_MATH_DELIMITER_MAP: Record<string, string> = {
  '\\[': '$$',
  '\\]': '$$',
  '\\(': '$',
  '\\)': '$',
};

/**
 * Normalize bracket-style math delimiters (\[...\] and \(...\)) — which many
 * models emit instead of dollar delimiters — into the $$...$$ / $...$ forms
 * that marked-katex-extension understands. Only prose segments are rewritten;
 * fenced code blocks and inline code keep their literal backslash delimiters.
 */
function normalizeBracketMathDelimiters(content: string): string {
  return content
    .split(CODE_FENCE_RE)
    .map((fencePart, fenceIdx) => {
      if (fenceIdx % 2 === 1) return fencePart;

      return fencePart
        .split(INLINE_CODE_RE)
        .map((inlinePart, inlineIdx) => {
          if (inlineIdx % 2 === 1) return inlinePart;
          return inlinePart.replace(
            BRACKET_MATH_DELIMITER_RE,
            (match) => BRACKET_MATH_DELIMITER_MAP[match],
          );
        })
        .join('');
    })
    .join('');
}

function normalizeIndentedDisplayMath(content: string): string {
  return content
    .split(CODE_FENCE_RE)
    .map((part, partIndex) => {
      if (partIndex % 2 === 1) return part;

      const lines = part.split('\n');
      let mathIndent = '';
      let inDisplayMath = false;

      return lines
        .map((line) => {
          const delimiterMatch = DISPLAY_MATH_DELIMITER_LINE_RE.exec(line);
          if (delimiterMatch) {
            if (!inDisplayMath) {
              mathIndent = delimiterMatch[1];
              inDisplayMath = true;
            } else {
              inDisplayMath = false;
            }
            return '$$';
          }

          if (inDisplayMath && mathIndent && line.startsWith(mathIndent)) {
            return line.slice(mathIndent.length);
          }

          return line;
        })
        .join('\n');
    })
    .join('');
}

function stripAndEscapeOutsideCodeBlocks(content: string): string {
  // First split by fenced code blocks
  const fenceParts = content.split(CODE_FENCE_RE);

  return fenceParts
    .map((fencePart, fenceIdx) => {
      // Odd indices are code fence matches — leave untouched
      if (fenceIdx % 2 === 1) return fencePart;

      // Then split by inline code within prose segments
      const inlineParts = fencePart.split(INLINE_CODE_RE);
      return inlineParts
        .map((inlinePart, inlineIdx) => {
          // Odd indices are inline code matches — leave untouched for marked to handle
          if (inlineIdx % 2 === 1) return inlinePart;
          return escapeXmlTags(stripSystemTags(inlinePart));
        })
        .join('');
    })
    .join('');
}

function isLatexCodeLanguage(language: string | null): boolean {
  return language !== null && LATEX_CODE_LANGUAGES.has(language.toLowerCase());
}

function unwrapLatexCodeBlockSource(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  const displayBlockMatch = trimmed.match(/^\$\$\s*([\s\S]*?)\s*\$\$$/);
  if (displayBlockMatch) {
    return (displayBlockMatch[1] ?? '').trim();
  }

  const bracketBlockMatch = trimmed.match(/^\\\[\s*([\s\S]*?)\s*\\\]$/);
  if (bracketBlockMatch) {
    return (bracketBlockMatch[1] ?? '').trim();
  }

  const inlineParenMatch = trimmed.match(/^\\\(\s*([\s\S]*?)\s*\\\)$/);
  if (inlineParenMatch) {
    return (inlineParenMatch[1] ?? '').trim();
  }

  return trimmed;
}

function renderLatexPreviewHtml(source: string): string | null {
  const latex = unwrapLatexCodeBlockSource(source);
  if (!latex) {
    return null;
  }

  try {
    const rendered = katex.renderToString(latex, {
      displayMode: true,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
    });
    return rendered.includes('katex-error') ? null : rendered;
  } catch {
    return null;
  }
}

/**
 * Full markdown pipeline for a single top-level block: marked + DOMPurify +
 * LaTeX previews + copy buttons + linkify. This is the ONLY renderer — used
 * both during streaming (per memoized block) and after — so streaming output
 * and final output are identical by construction.
 */
function renderFullMarkdownHtml(
  content: string,
  linkifyCapabilities: LinkifyCapabilities,
  copySuccessText: string,
  copyCodeTitle: string,
): string {
  try {
    // Strip system-internal XML tags and escape remaining XML tags outside code blocks
    // (mirrors CLI's stripPromptXMLTags + html token discard)
    const cleaned = stripAndEscapeOutsideCodeBlocks(
      normalizeIndentedDisplayMath(normalizeBracketMathDelimiters(content)),
    );
    const parsed = marked.parse(cleaned);
    const sanitized = DOMPurify.sanitize(
      typeof parsed === 'string' ? parsed : String(parsed),
      {
        ...MARKDOWN_LINK_SANITIZE_OPTIONS,
        ADD_ATTR: ['class', 'data-lang', 'data-copy-success', 'data-copy-title'],
      }
    );
    const rawHtml = sanitized.trim();

    if (typeof window === 'undefined' || !rawHtml) {
      return rawHtml;
    }

    const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
    const pres = doc.querySelectorAll('pre');

    pres.forEach((pre) => {
      const code = pre.querySelector('code');
      const languageTag = code ? (code.className.match(/language-([\w-]+)/i)?.[1] ?? null) : null;
      if (!isLatexCodeLanguage(languageTag)) {
        return;
      }

      const previewHtml = renderLatexPreviewHtml(code?.textContent ?? '');
      if (!previewHtml) {
        return;
      }

      const wrapper = doc.createElement('div');
      wrapper.className = 'code-block-wrapper latex-code-block-wrapper';
      pre.parentNode?.insertBefore(wrapper, pre);

      const preview = doc.createElement('div');
      preview.className = 'latex-code-block-preview';
      preview.innerHTML = previewHtml;

      wrapper.appendChild(preview);
      wrapper.appendChild(pre);
      pre.style.display = 'none';
    });

    decorateExistingAnchors(doc.body);

    pres.forEach((pre) => {
      const parent = pre.parentElement;
      if (parent && parent.classList.contains('code-block-wrapper')) {
        return;
      }

      const wrapper = doc.createElement('div');
      wrapper.className = 'code-block-wrapper';

      pre.parentNode?.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-code-btn';
      btn.title = copyCodeTitle;
      btn.setAttribute('aria-label', copyCodeTitle);

      const iconSpan = doc.createElement('span');
      iconSpan.className = 'copy-icon';
      iconSpan.innerHTML = copyIconSvg;

      const tooltipSpan = doc.createElement('span');
      tooltipSpan.className = 'copy-tooltip';
      tooltipSpan.textContent = copySuccessText;

      btn.appendChild(iconSpan);
      btn.appendChild(tooltipSpan);

      wrapper.appendChild(btn);
    });

    linkifyHtml(doc.body, linkifyCapabilities);

    return doc.body.innerHTML.trim();
  } catch (e) {
    // If marked/DOMPurify throws, never return raw `content` to
    // dangerouslySetInnerHTML — escape HTML special chars so any malicious
    // payload renders as literal text instead of executable markup.
    if (typeof console !== 'undefined' && console.error) {
      console.error('[MarkdownBlock] Render failed, falling back to escaped text:', e);
    }
    return content.replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return ch;
      }
    });
  }
}

interface BlockSectionProps {
  source: string;
  isStreamingTail: boolean;
  linkifyCapabilities: LinkifyCapabilities;
  copySuccessText: string;
  copyCodeTitle: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * One top-level markdown block, memoized by source text. During streaming only
 * the tail block's source changes; every earlier block skips re-parsing, and
 * because its `__html` string is unchanged React never touches its DOM.
 */
const BlockSection = memo(function BlockSection({
  source,
  isStreamingTail,
  linkifyCapabilities,
  copySuccessText,
  copyCodeTitle,
  containerRef,
}: BlockSectionProps) {
  const html = useMemo(
    () =>
      renderFullMarkdownHtml(
        // The tail block may end mid-fence or mid-backtick while tokens are
        // still arriving — temporarily close the structure so marked can parse
        // it. Once the real closing token arrives the source itself contains
        // it, makeStreamSafe becomes a no-op, and the HTML string is unchanged.
        isStreamingTail ? makeStreamSafe(source) : source,
        linkifyCapabilities,
        copySuccessText,
        copyCodeTitle,
      ),
    [source, isStreamingTail, linkifyCapabilities, copySuccessText, copyCodeTitle],
  );

  // Streaming selection preservation: when this block's HTML changes, its
  // innerHTML rewrite destroys the text nodes underneath an active selection.
  // Capture the selection as character offsets over the whole message
  // container during render — the old text nodes are still in place, and
  // stable blocks keep theirs, so offsets stay valid even for selections
  // spanning multiple blocks — then re-anchor the Range in a layout effect,
  // before paint, so there is no flicker.
  //
  // committedHtmlRef is read here but only mutated inside the layout effect
  // below, so a discarded concurrent render can't poison the "last committed"
  // comparison. rescuedSelectionRef is written during render as a deferred
  // payload for that effect; the value is idempotent across double-invoked
  // renders and never influences render output.
  const committedHtmlRef = useRef(html);
  const rescuedSelectionRef = useRef<TextSelectionOffsets | null>(null);

  if (committedHtmlRef.current !== html && containerRef.current) {
    rescuedSelectionRef.current = captureRangeOffsets(containerRef.current);
  }

  useLayoutEffect(() => {
    committedHtmlRef.current = html;
    const rescued = rescuedSelectionRef.current;
    if (rescued && containerRef.current) {
      restoreRangeOffsets(containerRef.current, rescued);
    }
    rescuedSelectionRef.current = null;
  }, [html, containerRef]);

  return <div className="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
});

// Copy icon SVG (hoisted to module scope to avoid recreation on each render)
const copyIconSvg = `
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor" fill-opacity="0.9"/>
      <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fill-opacity="0.6"/>
    </svg>
  `;

const MarkdownBlock = ({ content = '', isStreaming = false }: MarkdownBlockProps) => {
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [linkifyCapabilities, setLinkifyCapabilities] = useState<LinkifyCapabilities>(() =>
    getLinkifyCapabilities(),
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const normalizedContent = useMemo(() => safeStringifyContent(content), [content]);

  // Split into top-level blocks. During streaming only the last block keeps
  // growing; every earlier block is memoized by source and never re-parsed,
  // so per-token render cost is O(last block) instead of O(document).
  const blocks = useMemo(
    () => splitMarkdownBlocks(normalizedContent.replace(/[\r\n]+$/, '')),
    [normalizedContent],
  );

  const copySuccessText = t('markdown.copySuccess');
  const copyCodeTitle = t('markdown.copyCode');

  const fileLinkTooltip = useMarkdownFileLinkTooltip();

  useEffect(() => {
    return subscribeLinkifyCapabilities(setLinkifyCapabilities);
  }, []);

  // Render mermaid diagrams after HTML updates (skipped during streaming)
  useMermaidDiagrams(containerRef, isStreaming, normalizedContent);

  const handleClick = useMarkdownClickHandler(containerRef, setPreviewSrc);

  // Selection preservation lives inside each BlockSection: stable blocks are
  // never rewritten (memoized identical `__html`), only the streaming tail
  // re-anchors the Range across its own rebuilds.
  return (
    <>
      <div
        ref={containerRef}
        className="markdown-content"
        onClick={handleClick}
        onMouseOver={fileLinkTooltip.handleMouseOver}
        onMouseMove={fileLinkTooltip.handleMouseMove}
        onMouseOut={fileLinkTooltip.handleMouseOut}
      >
        {blocks.map((source, index) => (
          <BlockSection
            key={index}
            source={source}
            isStreamingTail={isStreaming && index === blocks.length - 1}
            linkifyCapabilities={linkifyCapabilities}
            copySuccessText={copySuccessText}
            copyCodeTitle={copyCodeTitle}
            containerRef={containerRef}
          />
        ))}
      </div>
      {/* Tooltip is managed via native DOM API in handleMouseOver/handleMouseOut
          to avoid React re-render issues that break click events in JCEF. */}
      {previewSrc && (
        <ImagePreviewOverlay
          src={previewSrc}
          closeTitle={t('chat.closePreview')}
          onClose={() => setPreviewSrc(null)}
        />
      )}
    </>
  );
};

export default memo(MarkdownBlock);
