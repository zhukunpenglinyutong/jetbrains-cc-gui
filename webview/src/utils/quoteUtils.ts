const QUOTE_PREFIX = '> ';

/** Turn arbitrary text into a Markdown blockquote. */
export function formatAsMarkdownQuote(text: string): string {
  const body = text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const quotedBody = body
    .split('\n')
    .map((line) => `${QUOTE_PREFIX}${line}`.replace(/\s+$/, ''))
    .join('\n');
  // Trailing newline leaves the caret on a fresh, non-quoted line for the user's question.
  return `${quotedBody}\n`;
}

/** Insert the given selection as an inline quote chip in the chat input and focus it. Returns false when there is nothing to quote. */
export function quoteToChatInput(text: string): boolean {
  if (!text.trim()) return false;
  if (!window.addQuotedSnippet) return false;
  window.addQuotedSnippet(JSON.stringify({ text }));
  window.focusChatInput?.();
  return true;
}
