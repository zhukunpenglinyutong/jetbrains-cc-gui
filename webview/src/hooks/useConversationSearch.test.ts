/**
 * Unit tests for useConversationSearch.
 *
 * Covers:
 *   - text matching (case-insensitive, multiple occurrences, multiple nodes)
 *   - code-block matching (whole <pre> tagged)
 *   - cleanup leaves zero residue
 *   - navigation (next/previous wrap correctly)
 *   - empty / no-result queries
 */
import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useConversationSearch,
  clearSearchDecorations,
  collectTextMatches,
  buildMatchRegex,
  escapeRegExp,
  DEFAULT_SEARCH_OPTIONS,
} from './useConversationSearch';
import type { SearchOptions } from './useConversationSearch';

const OPTS_CASE: SearchOptions = { matchCase: true, wholeWord: false, regex: false };
const OPTS_WHOLE: SearchOptions = { matchCase: false, wholeWord: true, regex: false };
const OPTS_REGEX: SearchOptions = { matchCase: false, wholeWord: false, regex: true };
const OPTS_CASE_REGEX: SearchOptions = { matchCase: true, wholeWord: false, regex: true };

function setupContainer(html: string): { container: HTMLDivElement; ref: { current: HTMLDivElement } } {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  return { container, ref: { current: container } };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

describe('collectTextMatches', () => {
  it('finds case-insensitive occurrences across separate text nodes', () => {
    const { container } = setupContainer(
      '<div>Hello World</div><div>HELLO again</div>'
    );
    const occs = collectTextMatches(container, 'hello');
    expect(occs.length).toBe(2);
  });

  it('skips text inside <pre> blocks', () => {
    const { container } = setupContainer(
      '<div>found</div><pre><code>found</code></pre>'
    );
    const occs = collectTextMatches(container, 'found');
    // Only the div text should be collected; <pre> is excluded from TreeWalker.
    expect(occs.length).toBe(1);
  });

  it('returns empty list for empty query', () => {
    const { container } = setupContainer('<div>anything</div>');
    expect(collectTextMatches(container, '')).toEqual([]);
  });

  it('handles multiple matches in the same text node', () => {
    const { container } = setupContainer('<div>abcabcabc</div>');
    const occs = collectTextMatches(container, 'abc');
    expect(occs.length).toBe(3);
    expect(occs.map((o) => o.start)).toEqual([0, 3, 6]);
  });
});

describe('clearSearchDecorations', () => {
  it('unwraps marks and removes block tags', () => {
    const { container } = setupContainer(
      '<p>before <mark class="cc-search-match is-current">match</mark> after</p>' +
      '<pre class="cc-search-block-match"><code>code</code></pre>'
    );
    clearSearchDecorations(container);
    expect(container.querySelectorAll('mark.cc-search-match').length).toBe(0);
    expect(container.querySelectorAll('.cc-search-block-match').length).toBe(0);
    // Text is preserved
    expect(container.textContent).toContain('before match after');
  });

  it('is a no-op on a clean container', () => {
    const { container } = setupContainer('<p>nothing here</p>');
    clearSearchDecorations(container);
    expect(container.innerHTML).toBe('<p>nothing here</p>');
  });
});

describe('useConversationSearch — hook behavior', () => {
  it('produces no matches for empty query', () => {
    const { ref } = setupContainer('<p>Some hello message</p>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
      }),
    );
    expect(result.current.query).toBe('');
    expect(result.current.matches.length).toBe(0);
    expect(result.current.currentIndex).toBe(-1);
  });

  it('finds and wraps matches after debounce, then cleans up', async () => {
    const { ref } = setupContainer(
      '<div>The login page</div><div>Another login attempt</div>'
    );
    const { result, unmount } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
      }),
    );

    act(() => { result.current.setQuery('login'); });
    // Wait for debounce
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(2);
    expect(result.current.currentIndex).toBe(0);
    expect(ref.current.querySelectorAll('mark.cc-search-match').length).toBe(2);

    // Navigation wraps
    act(() => { result.current.next(); });
    expect(result.current.currentIndex).toBe(1);
    act(() => { result.current.next(); });
    expect(result.current.currentIndex).toBe(0);
    act(() => { result.current.previous(); });
    expect(result.current.currentIndex).toBe(1);

    // Unmount cleans up
    unmount();
    expect(ref.current.querySelectorAll('mark.cc-search-match').length).toBe(0);
  });

  it('tags <pre> blocks when query is inside code', () => {
    const { ref } = setupContainer(
      '<pre><code>const login = async () => {}</code></pre>'
    );
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
      }),
    );
    act(() => { result.current.setQuery('login'); });
    act(() => { vi.advanceTimersByTime(20); });
    // One match — the <pre> block — not the inner text.
    expect(result.current.matches.length).toBe(1);
    expect(result.current.matches[0].blockElement?.tagName).toBe('PRE');
    expect(ref.current.querySelectorAll('.cc-search-block-match').length).toBe(1);
  });

  it('calls ensureRevealed once per query change and reports expandedCount', () => {
    const { ref } = setupContainer('<div>nothing matches</div>');
    const ensureRevealed = vi.fn(() => 7);
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        ensureRevealed,
        enabled: true,
        debounceMs: 5,
      }),
    );
    act(() => { result.current.setQuery('x'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(ensureRevealed).toHaveBeenCalled();
    expect(result.current.expandedCount).toBe(7);
  });

  it('clears decorations when disabled', () => {
    const { ref } = setupContainer('<div>The login page</div>');
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useConversationSearch({
          containerRef: ref,
          messagesSignal: '1',
          enabled,
          debounceMs: 5,
        }),
      { initialProps: { enabled: true } },
    );
    act(() => { result.current.setQuery('login'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(ref.current.querySelectorAll('mark.cc-search-match').length).toBe(1);

    rerender({ enabled: false });
    expect(ref.current.querySelectorAll('mark.cc-search-match').length).toBe(0);
    expect(result.current.matches.length).toBe(0);
  });

  it('handles three matches in one text node correctly', () => {
    const { ref } = setupContainer('<div>abc abc abc</div>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
      }),
    );
    act(() => { result.current.setQuery('abc'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(3);
    // All three are visible as <mark> elements
    const marks = ref.current.querySelectorAll('mark.cc-search-match');
    expect(marks.length).toBe(3);
    expect([...marks].map((m) => m.textContent)).toEqual(['abc', 'abc', 'abc']);
  });

  it('re-scans when messagesSignal changes (simulating streaming chunks)', () => {
    const { ref } = setupContainer('<div>Starting login</div>');
    const { result, rerender } = renderHook(
      ({ signal }) =>
        useConversationSearch({
          containerRef: ref,
          messagesSignal: signal,
          enabled: true,
          debounceMs: 5,
        }),
      { initialProps: { signal: 'len-1' } },
    );
    act(() => { result.current.setQuery('login'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(1);

    // Simulate a streaming chunk: append another "login" to the rendered DOM
    // and bump the signal as ChatScreen would.
    act(() => {
      const div = ref.current.querySelector('div');
      if (div) div.textContent = 'Starting login and re-login';
    });
    rerender({ signal: 'len-2' });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(2);
  });

  it('handles a match at the very beginning of a text node (start=0)', () => {
    const { ref } = setupContainer('<div>abc rest of text</div>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
      }),
    );
    act(() => { result.current.setQuery('abc'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(1);
    expect(result.current.matches[0].markElement?.textContent).toBe('abc');
    // Cleanup leaves the original text intact after a re-scan with empty query.
    act(() => { result.current.setQuery(''); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(ref.current.textContent).toBe('abc rest of text');
    expect(ref.current.querySelectorAll('mark.cc-search-match').length).toBe(0);
  });

  it('wraps adjacent occurrences in the same text node without losing characters', () => {
    // Regression: when two matches are physically adjacent (no separator),
    // right-to-left splitText must still preserve the leading remnant for
    // the earlier match.
    const { ref } = setupContainer('<div>abcabcabc</div>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
      }),
    );
    act(() => { result.current.setQuery('abc'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(3);
    const marks = ref.current.querySelectorAll('mark.cc-search-match');
    expect(marks.length).toBe(3);
    expect([...marks].map((m) => m.textContent).join('')).toBe('abcabcabc');
    // Clean up restores the original text exactly.
    act(() => { result.current.setQuery(''); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(ref.current.textContent).toBe('abcabcabc');
    expect(ref.current.querySelectorAll('mark.cc-search-match').length).toBe(0);
  });

  it('handles a match at the very end of a text node (end=length)', () => {
    const { ref } = setupContainer('<div>prefix abc</div>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
      }),
    );
    act(() => { result.current.setQuery('abc'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(1);
    expect(result.current.matches[0].markElement?.textContent).toBe('abc');
    act(() => { result.current.setQuery(''); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(ref.current.textContent).toBe('prefix abc');
  });
});

describe('escapeRegExp', () => {
  it('escapes all regex metacharacters', () => {
    expect(escapeRegExp('a.b*c+d?e^f$g(h)i|j[k]l\\m{n}')).toBe(
      'a\\.b\\*c\\+d\\?e\\^f\\$g\\(h\\)i\\|j\\[k\\]l\\\\m\\{n\\}',
    );
  });
  it('leaves alphanumerics untouched', () => {
    expect(escapeRegExp('abc123XYZ')).toBe('abc123XYZ');
  });
});

describe('buildMatchRegex', () => {
  it('returns null for empty query', () => {
    expect(buildMatchRegex('', DEFAULT_SEARCH_OPTIONS)).toBeNull();
  });
  it('returns case-insensitive regex by default', () => {
    const re = buildMatchRegex('abc', DEFAULT_SEARCH_OPTIONS);
    expect(re?.flags).toBe('gi');
    expect(re?.test('ABC')).toBe(true);
  });
  it('returns case-sensitive regex when matchCase is on', () => {
    const re = buildMatchRegex('abc', OPTS_CASE);
    expect(re?.flags).toBe('g');
    expect(re?.test('ABC')).toBe(false);
    expect(re?.test('abc')).toBe(true);
  });
  it('wraps in \\b for whole word matching', () => {
    const re = buildMatchRegex('cat', OPTS_WHOLE);
    expect(re?.source).toBe('\\bcat\\b');
    expect(re?.test('the cat sat')).toBe(true);
    re!.lastIndex = 0;
    expect(re?.test('catalog')).toBe(false);
  });
  it('escapes special characters in non-regex mode', () => {
    const re = buildMatchRegex('a.b', DEFAULT_SEARCH_OPTIONS);
    expect(re?.test('a.b')).toBe(true);
    re!.lastIndex = 0;
    expect(re?.test('axb')).toBe(false);
  });
  it('does NOT escape special characters in regex mode', () => {
    const re = buildMatchRegex('a.b', OPTS_REGEX);
    expect(re?.test('axb')).toBe(true);
  });
  it('returns null for invalid regex', () => {
    expect(buildMatchRegex('(', OPTS_REGEX)).toBeNull();
    expect(buildMatchRegex('[a-', OPTS_REGEX)).toBeNull();
  });
  it('combines matchCase + regex correctly', () => {
    const re = buildMatchRegex('Foo', OPTS_CASE_REGEX);
    expect(re?.flags).toBe('g');
    expect(re?.test('foo')).toBe(false);
    re!.lastIndex = 0;
    expect(re?.test('Foo')).toBe(true);
  });
});

describe('collectTextMatches — search options', () => {
  it('matchCase: distinguishes case', () => {
    const { container } = setupContainer('<div>Hello HELLO hello</div>');
    expect(collectTextMatches(container, 'hello', DEFAULT_SEARCH_OPTIONS).length).toBe(3);
    expect(collectTextMatches(container, 'hello', OPTS_CASE).length).toBe(1);
  });
  it('wholeWord: rejects substring matches', () => {
    const { container } = setupContainer('<div>cat catalog scat cat</div>');
    expect(collectTextMatches(container, 'cat', DEFAULT_SEARCH_OPTIONS).length).toBe(4);
    expect(collectTextMatches(container, 'cat', OPTS_WHOLE).length).toBe(2);
  });
  it('regex: treats pattern as RegExp', () => {
    const { container } = setupContainer('<div>error 404 and warning 500</div>');
    const occs = collectTextMatches(container, '\\d+', OPTS_REGEX);
    expect(occs.length).toBe(2);
  });
  it('regex: returns empty on invalid pattern instead of throwing', () => {
    const { container } = setupContainer('<div>anything</div>');
    expect(collectTextMatches(container, '(', OPTS_REGEX)).toEqual([]);
  });
});

describe('useConversationSearch — Polish features', () => {
  it('matchCase narrows match count', () => {
    const { ref } = setupContainer('<div>Foo foo FOO</div>');
    const { result, rerender } = renderHook(
      ({ opts }) =>
        useConversationSearch({
          containerRef: ref,
          messagesSignal: '1',
          enabled: true,
          debounceMs: 5,
          searchOptions: opts,
        }),
      { initialProps: { opts: DEFAULT_SEARCH_OPTIONS } },
    );
    act(() => { result.current.setQuery('foo'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(3);
    rerender({ opts: OPTS_CASE });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(1);
  });

  it('wholeWord rejects partial matches', () => {
    const { ref } = setupContainer('<div>test testing tested</div>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
        searchOptions: OPTS_WHOLE,
      }),
    );
    act(() => { result.current.setQuery('test'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(1);
  });

  it('regex matches by pattern', () => {
    const { ref } = setupContainer('<div>code 200, 404, 500</div>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
        searchOptions: OPTS_REGEX,
      }),
    );
    act(() => { result.current.setQuery('\\d{3}'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(3);
    expect(result.current.isRegexInvalid).toBe(false);
  });

  it('flags invalid regex without crashing', () => {
    const { ref } = setupContainer('<div>some text</div>');
    const { result } = renderHook(() =>
      useConversationSearch({
        containerRef: ref,
        messagesSignal: '1',
        enabled: true,
        debounceMs: 5,
        searchOptions: OPTS_REGEX,
      }),
    );
    act(() => { result.current.setQuery('([a-z'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.isRegexInvalid).toBe(true);
    expect(result.current.matches.length).toBe(0);
    // Recovers when the pattern becomes valid
    act(() => { result.current.setQuery('[a-z]'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.isRegexInvalid).toBe(false);
    expect(result.current.matches.length).toBeGreaterThan(0);
  });

  it('toggling options triggers a re-scan without changing the query', () => {
    const { ref } = setupContainer('<div>Foo foo FOO</div>');
    const { result, rerender } = renderHook(
      ({ opts }) =>
        useConversationSearch({
          containerRef: ref,
          messagesSignal: '1',
          enabled: true,
          debounceMs: 5,
          searchOptions: opts,
        }),
      { initialProps: { opts: DEFAULT_SEARCH_OPTIONS } },
    );
    act(() => { result.current.setQuery('foo'); });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(3);

    rerender({ opts: OPTS_CASE });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(1);

    rerender({ opts: DEFAULT_SEARCH_OPTIONS });
    act(() => { vi.advanceTimersByTime(20); });
    expect(result.current.matches.length).toBe(3);
  });
});
