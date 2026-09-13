import { describe, it, expect } from 'vitest';
import {
  registerQuote,
  getQuote,
  removeQuote,
  makeQuoteToken,
  quoteTokenLength,
  hasQuoteToken,
  quotePreview,
  createQuoteChipElement,
  expandQuoteTokens,
  pruneQuoteRegistry,
} from './quoteRegistry';

describe('quoteRegistry token round-trip', () => {
  it('registers a quote and expands its token into a Markdown blockquote', () => {
    const id = registerQuote('line one\nline two');
    const token = makeQuoteToken(id);

    expect(hasQuoteToken(`before ${token} after`)).toBe(true);
    expect(quoteTokenLength(id)).toBe(token.length);

    const expanded = expandQuoteTokens(`ask: ${token}please`);
    expect(expanded).toBe('ask: > line one\n> line two\nplease');
  });

  it('drops unknown tokens on expand', () => {
    const id = registerQuote('gone');
    const token = makeQuoteToken(id);
    removeQuote(id);
    expect(getQuote(id)).toBeUndefined();
    expect(expandQuoteTokens(`x${token}y`)).toBe('xy');
  });

  it('expands multiple tokens in one pass', () => {
    const first = makeQuoteToken(registerQuote('aaa'));
    const second = makeQuoteToken(registerQuote('bbb'));
    expect(expandQuoteTokens(`${first}${second}`)).toBe('> aaa\n> bbb\n');
  });
});

describe('pruneQuoteRegistry', () => {
  it('drops entries whose ids are no longer active and keeps the rest', () => {
    const keep = registerQuote('still here');
    const stale = registerQuote('deleted chip');

    pruneQuoteRegistry(new Set([keep]));

    expect(getQuote(keep)).toBeDefined();
    expect(getQuote(stale)).toBeUndefined();
  });

  it('prunes everything when the input was cleared', () => {
    const a = registerQuote('a');
    const b = registerQuote('b');

    pruneQuoteRegistry(new Set());

    expect(getQuote(a)).toBeUndefined();
    expect(getQuote(b)).toBeUndefined();
  });
});

describe('quotePreview', () => {
  it('collapses whitespace and truncates long text', () => {
    expect(quotePreview('short\n  text')).toBe('short text');
    expect(quotePreview('x'.repeat(60), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('createQuoteChipElement', () => {
  it('builds a non-editable chip carrying the id and a preview', () => {
    const id = registerQuote('the quoted body');
    const chip = createQuoteChipElement(id, { text: 'the quoted body' });

    expect(chip.classList.contains('quote-tag')).toBe(true);
    expect(chip.getAttribute('contenteditable')).toBe('false');
    expect(chip.getAttribute('data-quote-id')).toBe(id);
    expect(chip.querySelector('.quote-tag-text')?.textContent).toBe('the quoted body');
    expect(chip.querySelector('.quote-tag-close')?.textContent).toBe('×');
  });
});
