import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatAsMarkdownQuote, quoteToChatInput } from './quoteUtils';

describe('formatAsMarkdownQuote', () => {
  it('prefixes every line and adds a trailing newline', () => {
    expect(formatAsMarkdownQuote('line1\nline2')).toBe('> line1\n> line2\n');
  });

  it('trims trailing blank lines and normalizes CRLF', () => {
    expect(formatAsMarkdownQuote('a\r\nb\n\n')).toBe('> a\n> b\n');
  });
});

describe('quoteToChatInput', () => {
  afterEach(() => {
    delete window.addQuotedSnippet;
    delete window.focusChatInput;
  });

  it('sends the raw quote as a chip payload and focuses the input', () => {
    const addSnippet = vi.fn();
    const focus = vi.fn();
    window.addQuotedSnippet = addSnippet;
    window.focusChatInput = focus;

    expect(quoteToChatInput('text')).toBe(true);
    expect(addSnippet).toHaveBeenCalledWith(JSON.stringify({ text: 'text' }));
    expect(focus).toHaveBeenCalled();
  });

  it('returns false for empty selections', () => {
    window.addQuotedSnippet = vi.fn();
    expect(quoteToChatInput('   ')).toBe(false);
    expect(window.addQuotedSnippet).not.toHaveBeenCalled();
  });
});
