import { formatAsMarkdownQuote } from '../../../utils/quoteUtils.js';

/**
 * Inline quote chips are represented in the input's virtual text by a compact
 * token delimited with Private Use Area characters so it can never collide with
 * anything the user types. The heavy Markdown blockquote lives only in this
 * registry and is expanded back into the text when the message is sent.
 */
const TOKEN_START = String.fromCharCode(0xe000);
const TOKEN_END = String.fromCharCode(0xe001);

export interface QuoteEntry {
  text: string;
}

const registry = new Map<string, QuoteEntry>();
let quoteCounter = 0;

export function registerQuote(text: string): string {
  const id = `q${(quoteCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  registry.set(id, { text });
  return id;
}

export function getQuote(id: string): QuoteEntry | undefined {
  return registry.get(id);
}

export function removeQuote(id: string): void {
  registry.delete(id);
}

/**
 * Drop registry entries whose tokens are no longer present in the input
 * (deleted chip, cleared input, message sent). Keeps the module-level map
 * from growing unbounded over a long session.
 */
export function pruneQuoteRegistry(activeIds: ReadonlySet<string>): void {
  for (const id of registry.keys()) {
    if (!activeIds.has(id)) {
      registry.delete(id);
    }
  }
}

export function makeQuoteToken(id: string): string {
  return `${TOKEN_START}${id}${TOKEN_END}`;
}

/** Virtual length of a quote token — kept in sync with makeQuoteToken for cursor math. */
export function quoteTokenLength(id: string): number {
  return id.length + 2;
}

/** True when the text contains at least one quote token opener. */
export function hasQuoteToken(text: string): boolean {
  return text.includes(TOKEN_START);
}

/** Fresh regex each call so the shared lastIndex of a /g literal never bites us. */
export function quoteTokenRegex(): RegExp {
  return new RegExp(`${TOKEN_START}([^${TOKEN_START}${TOKEN_END}]+)${TOKEN_END}`, 'g');
}

/** Short single-line preview shown on the chip. */
export function quotePreview(text: string, maxLength = 40): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength).trimEnd()}…` : collapsed;
}

/** Build the inline chip element. Uses textContent to avoid any HTML escaping concerns. */
export function createQuoteChipElement(id: string, entry: QuoteEntry): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'quote-tag has-tooltip';
  chip.setAttribute('contenteditable', 'false');
  chip.setAttribute('data-quote-id', id);
  chip.setAttribute('data-tooltip', entry.text);

  const icon = document.createElement('span');
  icon.className = 'quote-tag-icon';
  icon.textContent = '❝';

  const preview = document.createElement('span');
  preview.className = 'quote-tag-text';
  preview.textContent = quotePreview(entry.text);

  const close = document.createElement('span');
  close.className = 'quote-tag-close';
  close.textContent = '×';

  chip.append(icon, preview, close);
  return chip;
}

/** Replace every quote token in the given text with its full Markdown blockquote. Unknown tokens are dropped. */
export function expandQuoteTokens(text: string): string {
  return text.replace(quoteTokenRegex(), (_whole, id: string) => {
    const entry = registry.get(id);
    return entry ? formatAsMarkdownQuote(entry.text) : '';
  });
}
