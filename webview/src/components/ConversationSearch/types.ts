/**
 * Conversation in-page search types.
 *
 * Architecture note (per project rule "codex-history-replay-pitfalls.md"
 * Iron Law 1): search must be driven by `mergedMessages` content, not by
 * lifecycle events such as `onStreamEnd`, so that historical session replay
 * (which goes through `historyLoadComplete`) is supported identically to
 * live streaming.
 */

/**
 * One textual match found in the messages container.
 *
 * For plain text matches, `markElement` is the `<mark>` wrapping the
 * matched substring.
 *
 * For code-block matches (we don't dive into hljs's nested spans —
 * see project rule "PreToolUse:tmux 提醒" and design decision in the plan),
 * `blockElement` is the entire `<pre>` element that the user typed search
 * query appears inside; `markElement` is null in that case.
 */
export interface ConversationSearchMatch {
  /** Stable ID for React keys, derived from match position. */
  id: string;
  /** The <mark> element wrapping a plain-text match. */
  markElement: HTMLElement | null;
  /** The <pre> element when the match falls inside a code block. */
  blockElement: HTMLElement | null;
  /** Lower-cased preview of nearby text (debug aid; not currently shown in UI). */
  preview?: string;
}

export interface ConversationSearchHandle {
  /** Open the search panel (focuses input). */
  open: () => void;
  /** Close the search panel and clear all highlights. */
  close: () => void;
  /** Whether the search panel is currently open. */
  isOpen: () => boolean;
}

/**
 * Optional API a parent component can expose so the search hook can force
 * the message list to unfold all earlier collapsed messages.
 */
export interface MessageListRevealHandle {
  /** Reveal every message currently hidden behind the "show earlier" indicator. */
  revealAll: () => number;
}
