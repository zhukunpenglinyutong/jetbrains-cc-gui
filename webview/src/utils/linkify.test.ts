import { describe, expect, it } from 'vitest';
import {
  decorateExistingAnchors,
  isJavaFqcnCandidate,
  linkifyHtml,
  linkifyPlainTextSegment,
  parseFileLinkTarget,
} from './linkify';
import { DEFAULT_LINKIFY_CAPABILITIES } from './linkifyCapabilities';

describe('linkify', () => {
  it('parses file targets with line numbers and rejects column suffixes', () => {
    expect(parseFileLinkTarget('Main.java:128')).toEqual({
      path: 'Main.java',
      lineStart: 128,
      lineEnd: undefined,
    });

    expect(parseFileLinkTarget('src/foo/bar.ts:42-50')).toEqual({
      path: 'src/foo/bar.ts',
      lineStart: 42,
      lineEnd: 50,
    });

    expect(parseFileLinkTarget('E:\\project\\src\\Foo.java:42:15')).toBeNull();
  });

  it('recognizes valid Java FQCN values and rejects false positives', () => {
    expect(isJavaFqcnCandidate('com.github.foo.BarService')).toBe(true);
    expect(isJavaFqcnCandidate('com.github.foo.Outer.Inner')).toBe(true);
    expect(isJavaFqcnCandidate('com.example.api')).toBe(false);
    expect(isJavaFqcnCandidate('com.foo.Bar#baz')).toBe(false);
    expect(isJavaFqcnCandidate('v1.2.3')).toBe(false);
  });

  it('linkifies plain text paths, URLs, and Java classes', () => {
    const html = linkifyPlainTextSegment(
      'Open src/foo/bar.ts:42 then visit https://example.com/docs and inspect com.github.foo.BarService',
      { classNavigationEnabled: true },
    );

    expect(html).toContain('data-linkify="file"');
    expect(html).toContain('src/foo/bar.ts:42');
    expect(html).toContain('data-linkify="url"');
    expect(html).toContain('https://example.com/docs');
    expect(html).toContain('data-linkify="class"');
    expect(html).toContain('com.github.foo.BarService');
  });

  it('linkifies windows, posix, and explicit relative file paths', () => {
    const html = linkifyPlainTextSegment(
      'Open C:\\repo\\src\\Main.java, /home/user/project/src/main.ts, ./foo.ts, and ../shared/utils.ts',
      DEFAULT_LINKIFY_CAPABILITIES,
    );

    expect(html).toContain('C:\\repo\\src\\Main.java');
    expect(html).toContain('/home/user/project/src/main.ts');
    expect(html).toContain('./foo.ts');
    expect(html).toContain('../shared/utils.ts');
    expect((html.match(/data-linkify="file"/g) ?? []).length).toBe(4);
  });

  it('linkifies standalone source file names like linkify.ts', () => {
    const html = linkifyPlainTextSegment(
      'See linkify.ts and MarkdownBlock.test.tsx for implementation.',
      DEFAULT_LINKIFY_CAPABILITIES,
    );

    expect(html).toContain('data-linkify="file"');
    expect(html).toContain('linkify.ts');
    expect(html).toContain('MarkdownBlock.test.tsx');
    expect((html.match(/data-linkify="file"/g) ?? []).length).toBe(2);
  });

  it('does not linkify non-source file names like example.com', () => {
    const html = linkifyPlainTextSegment(
      'Visit example.com and read docs.pdf',
      DEFAULT_LINKIFY_CAPABILITIES,
    );

    // .com and .pdf are not source file extensions, should not be linked
    expect(html).not.toContain('href="example.com"');
    expect(html).not.toContain('href="docs.pdf"');
  });

  it('detects multiple file paths in one segment, including unicode path segments', () => {
    const html = linkifyPlainTextSegment(
      'Compare src/foo.ts, src/bar.ts, and ./中文/utils.ts before shipping.',
      DEFAULT_LINKIFY_CAPABILITIES,
    );

    expect((html.match(/data-linkify="file"/g) ?? []).length).toBe(3);
    expect(html).toContain('./中文/utils.ts');
  });

  it('does not linkify weak signals or unsupported path:line:column values', () => {
    const html = linkifyPlainTextSegment(
      'Ignore foo/bar, 123:456, abc:def, com.example.api and E:\\project\\Foo.java:42:15',
      { classNavigationEnabled: true },
    );

    expect(html).not.toContain('data-linkify="file"');
    expect(html).not.toContain('data-linkify="class"');
  });

  it('does not confuse lowercase package-like text with URLs or class links', () => {
    const html = linkifyPlainTextSegment(
      'Visit https://com.example.http/docs but keep com.example.http as plain text.',
      { classNavigationEnabled: true },
    );

    expect((html.match(/data-linkify="url"/g) ?? []).length).toBe(1);
    expect(html).not.toContain('data-linkify="class"');
    expect(html).toContain('com.example.http as plain text');
  });

  it('linkifies HTML text nodes while skipping anchors and code fences (pre blocks)', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<p>Open src/components/App.tsx and com.github.foo.BarService</p>',
      '<p><a href="https://example.com/docs">docs</a></p>',
      '<p><code>src/inline-code.ts</code> should be linkified</p>',
      '<pre>com.github.foo.IgnoredService</pre>',
    ].join('');

    decorateExistingAnchors(root);
    linkifyHtml(root, { classNavigationEnabled: true });

    expect(root.querySelector('a.file-link')?.textContent).toBe('src/components/App.tsx');
    expect(root.querySelector('a.class-link')?.textContent).toBe('com.github.foo.BarService');
    expect(root.querySelector('a.url-link')?.getAttribute('data-linkify')).toBe('url');
    // Inline code content should be linkified
    expect(root.querySelector('code a.file-link')?.textContent).toBe('src/inline-code.ts');
    // Code fence (pre) content should NOT be linkified
    expect(root.querySelector('pre a')).toBeNull();
  });

  it('linkifies file paths that appear immediately after an existing anchor', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p><a href="https://example.com/docs">docs</a>src/components/App.tsx</p>';

    decorateExistingAnchors(root);
    linkifyHtml(root, DEFAULT_LINKIFY_CAPABILITIES);

    expect(root.querySelector('a.url-link')?.textContent).toBe('docs');
    expect(root.querySelector('a.file-link')?.textContent).toBe('src/components/App.tsx');
  });

  it('keeps class links disabled when capability is off', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>com.github.foo.BarService</p>';

    linkifyHtml(root, DEFAULT_LINKIFY_CAPABILITIES);

    expect(root.querySelector('a.class-link')).toBeNull();
  });
});
