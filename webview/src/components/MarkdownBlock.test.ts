/**
 * Tests for renderStreamingContent — B-029 (tables) and list rendering.
 *
 * The function reads localStorage for streamingRenderTables / streamingRenderLists
 * toggles, so we mock localStorage to control them per test.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderStreamingContent } from './MarkdownBlock';

// Helper: set localStorage toggles
function setRenderSettings(tables: boolean, lists: boolean) {
  localStorage.setItem('streamingRenderTables', String(tables));
  localStorage.setItem('streamingRenderLists', String(lists));
}

describe('renderStreamingContent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // =========================================================================
  // Basic prose
  // =========================================================================

  it('returns empty string for empty input', () => {
    expect(renderStreamingContent('')).toBe('');
  });

  it('wraps plain text in <p> tags', () => {
    const result = renderStreamingContent('Hello world');
    expect(result).toContain('<p>');
    expect(result).toContain('Hello world');
  });

  it('renders inline code', () => {
    const result = renderStreamingContent('Use `foo()` here');
    expect(result).toContain('<code>foo()</code>');
  });

  it('renders bold text', () => {
    const result = renderStreamingContent('This is **bold** text');
    expect(result).toContain('<strong>bold</strong>');
  });

  it('renders headings', () => {
    const result = renderStreamingContent('## My Heading\nSome text');
    expect(result).toContain('<h2>My Heading</h2>');
  });

  // =========================================================================
  // Code blocks
  // =========================================================================

  it('renders fenced code blocks as <pre><code>', () => {
    const input = '```js\nconst x = 1;\n```\nDone.';
    const result = renderStreamingContent(input);
    expect(result).toContain('<pre><code class="language-js">');
    expect(result).toContain('const x = 1;');
    expect(result).toContain('</code></pre>');
  });

  it('auto-closes unclosed code blocks during streaming', () => {
    const input = '```python\nprint("hi")';
    const result = renderStreamingContent(input);
    expect(result).toContain('<pre><code class="language-python">');
    expect(result).toContain('print("hi")');
  });

  // =========================================================================
  // B-029: Table rendering
  // =========================================================================

  describe('tables (B-029)', () => {
    beforeEach(() => {
      setRenderSettings(true, false);
    });

    it('renders a complete table as HTML table', () => {
      const input = [
        '| Name | Age |',
        '| --- | --- |',
        '| Alice | 30 |',
        '| Bob | 25 |',
        '',
        'After table.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).toContain('<table>');
      expect(result).toContain('<thead>');
      expect(result).toContain('<th>Name</th>');
      expect(result).toContain('<th>Age</th>');
      expect(result).toContain('<tbody>');
      expect(result).toContain('<td>Alice</td>');
      expect(result).toContain('<td>Bob</td>');
      expect(result).toContain('</table>');
      expect(result).toContain('After table.');
    });

    it('keeps table as raw text when still streaming (no trailing non-pipe line)', () => {
      const input = [
        '| Name | Age |',
        '| --- | --- |',
        '| Alice | 30 |',
      ].join('\n');

      const result = renderStreamingContent(input);
      // Should NOT render as HTML table
      expect(result).not.toContain('<table>');
      // Should show pipe characters as text
      expect(result).toContain('Name');
      expect(result).toContain('Alice');
    });

    it('renders inline formatting inside table cells', () => {
      const input = [
        '| Feature | Status |',
        '| --- | --- |',
        '| **Bold** | `done` |',
        '',
        'End.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).toContain('<strong>Bold</strong>');
      expect(result).toContain('<code>done</code>');
    });

    it('does not render tables when setting is disabled', () => {
      setRenderSettings(false, false);

      const input = [
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        'End.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).not.toContain('<table>');
    });

    it('handles table with only header and separator (no data rows) followed by text', () => {
      const input = [
        '| H1 | H2 |',
        '| --- | --- |',
        '',
        'No data rows.',
      ].join('\n');

      const result = renderStreamingContent(input);
      // 2 lines (header + separator) < 3 minimum, so raw text
      expect(result).not.toContain('<table>');
    });
  });

  // =========================================================================
  // List rendering
  // =========================================================================

  describe('lists', () => {
    beforeEach(() => {
      setRenderSettings(false, true);
    });

    it('renders a complete unordered list as <ul>', () => {
      const input = [
        '- First item',
        '- Second item',
        '- Third item',
        '',
        'After list.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>First item</li>');
      expect(result).toContain('<li>Second item</li>');
      expect(result).toContain('<li>Third item</li>');
      expect(result).toContain('</ul>');
    });

    it('renders a complete ordered list as <ol>', () => {
      const input = [
        '1. Alpha',
        '2. Beta',
        '3. Gamma',
        '',
        'Done.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).toContain('<ol>');
      expect(result).toContain('<li>Alpha</li>');
      expect(result).toContain('<li>Beta</li>');
      expect(result).toContain('<li>Gamma</li>');
      expect(result).toContain('</ol>');
    });

    it('keeps list as raw text when still streaming (no trailing non-list line)', () => {
      const input = [
        '- Item one',
        '- Item two',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).not.toContain('<ul>');
      expect(result).not.toContain('<li>');
      expect(result).toContain('Item one');
    });

    it('renders inline formatting inside list items', () => {
      const input = [
        '- Use **bold** here',
        '- And `code` there',
        '',
        'End.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).toContain('<strong>bold</strong>');
      expect(result).toContain('<code>code</code>');
    });

    it('does not render lists when setting is disabled', () => {
      setRenderSettings(false, false);

      const input = [
        '- Item A',
        '- Item B',
        '',
        'End.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).not.toContain('<ul>');
      expect(result).not.toContain('<li>');
    });

    it('renders * bullet lists the same as - bullet lists', () => {
      const input = [
        '* Star one',
        '* Star two',
        '',
        'End.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Star one</li>');
    });
  });

  // =========================================================================
  // Tables + Lists combined
  // =========================================================================

  describe('tables and lists combined', () => {
    beforeEach(() => {
      setRenderSettings(true, true);
    });

    it('renders both a table and a list in the same content', () => {
      const input = [
        '| Col1 | Col2 |',
        '| --- | --- |',
        '| A | B |',
        '',
        'Some text.',
        '',
        '- Item 1',
        '- Item 2',
        '',
        'End.',
      ].join('\n');

      const result = renderStreamingContent(input);
      expect(result).toContain('<table>');
      expect(result).toContain('<td>A</td>');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>Item 1</li>');
    });
  });

  // =========================================================================
  // XSS / Sanitization
  // =========================================================================

  describe('sanitization', () => {
    it('escapes HTML in prose', () => {
      const result = renderStreamingContent('<script>alert("xss")</script>');
      expect(result).not.toContain('<script>');
    });

    it('escapes HTML in table cells', () => {
      setRenderSettings(true, false);
      const input = [
        '| Header |',
        '| --- |',
        '| <img onerror=alert(1)> |',
        '',
        'End.',
      ].join('\n');

      const result = renderStreamingContent(input);
      // The <img> tag must be escaped — no actual HTML element
      expect(result).not.toContain('<img');
      expect(result).toContain('&lt;img');
    });
  });
});
