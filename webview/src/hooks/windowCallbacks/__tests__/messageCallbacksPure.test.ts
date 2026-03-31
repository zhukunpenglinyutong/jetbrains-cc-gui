/**
 * Direct unit tests for the pure utility functions in messageCallbacks.ts.
 * These complement the integration tests in useWindowCallbacks.test.ts by
 * verifying boundary/edge cases of individual functions in isolation.
 */
import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../../../types';
import {
  _chooseMoreCompleteStreamingValue as chooseMore,
  _selectMostCompleteStreamingText as selectBest,
  _computeCanonicalStreamingState as computeCanonical,
  _getContentHash as getContentHash,
  _getStructuralBlockSignature as getSig,
  _hasStructuralBlockChange as hasChange,
  _collectAssistantBlocks as collectAssistantBlocks,
  _extractCanonicalTextFromBlocks as extractText,
  _extractCanonicalThinkingFromBlocks as extractThinking,
} from '../registerCallbacks/messageCallbacks';
import type { ContentBlock } from '../../useStreamingMessages';
import { extractRawBlocks } from '../../useStreamingMessages';

// ---------------------------------------------------------------------------
// chooseMoreCompleteStreamingValue
// ---------------------------------------------------------------------------
describe('chooseMoreCompleteStreamingValue', () => {
  it('returns current when candidate is empty', () => {
    expect(chooseMore('hello', '')).toBe('hello');
  });

  it('returns candidate when current is empty', () => {
    expect(chooseMore('', 'world')).toBe('world');
  });

  it('returns candidate when candidate is longer', () => {
    expect(chooseMore('abc', 'abcdef')).toBe('abcdef');
  });

  it('returns current when current is longer', () => {
    expect(chooseMore('abcdef', 'abc')).toBe('abcdef');
  });

  it('returns candidate for same-length meaningful difference', () => {
    expect(chooseMore('axc', 'abc')).toBe('abc');
  });

  it('returns current for same-length whitespace-only difference', () => {
    expect(chooseMore('a  b', 'a\tb')).toBe('a  b');
  });

  it('returns current when both are identical', () => {
    expect(chooseMore('same', 'same')).toBe('same');
  });

  it('returns empty string when both are empty', () => {
    expect(chooseMore('', '')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// selectMostCompleteStreamingText
// ---------------------------------------------------------------------------
describe('selectMostCompleteStreamingText', () => {
  it('returns streaming when it is the only source', () => {
    expect(selectBest('only', '', '')).toBe('only');
  });

  it('returns empty string when all sources are empty', () => {
    expect(selectBest('', '', '')).toBe('');
  });

  it('selects longest across three sources', () => {
    expect(selectBest('a', 'ab', 'abc')).toBe('abc');
  });

  it('backend wins on same-length meaningful difference (implicit priority)', () => {
    // streaming=abc, assistant=abc, backend=xyz — all length 3
    // Pairwise: best=abc, chooseMore(abc,abc)=abc, chooseMore(abc,xyz)=xyz
    expect(selectBest('abc', 'abc', 'xyz')).toBe('xyz');
  });

  it('returns assistant when streaming and backend are empty', () => {
    expect(selectBest('', 'assistant content', '')).toBe('assistant content');
  });

  it('returns backend when streaming and assistant are empty', () => {
    expect(selectBest('', '', 'backend content')).toBe('backend content');
  });
});

// ---------------------------------------------------------------------------
// computeCanonicalStreamingState
// ---------------------------------------------------------------------------
describe('computeCanonicalStreamingState', () => {
  const mkAssistant = (content: string, raw?: unknown) => ({
    type: 'assistant' as const,
    content,
    timestamp: new Date().toISOString(),
    raw: raw as any,
  });

  it('prefers longer backend text over shorter streaming snapshot', () => {
    const assistant = mkAssistant('short', {
      message: { content: [{ type: 'text', text: 'longer backend text' }] },
    });
    const result = computeCanonical(assistant, extractRawBlocks(assistant.raw), 'short', '');
    expect(result.nextText).toBe('longer backend text');
  });

  it('preserves longer streaming snapshot when backend text is shorter', () => {
    const assistant = mkAssistant('short', {
      message: { content: [{ type: 'text', text: 'short' }] },
    });
    const result = computeCanonical(assistant, extractRawBlocks(assistant.raw), 'longer streaming content', '');
    expect(result.nextText).toBe('longer streaming content');
  });

  it('handles empty raw blocks gracefully', () => {
    const assistant = mkAssistant('streaming', { message: { content: [] } });
    const result = computeCanonical(assistant, extractRawBlocks(assistant.raw), 'streaming', '');
    expect(result.nextText).toBe('streaming');
    expect(result.nextThinking).toBe('');
  });

  it('handles undefined raw gracefully', () => {
    const assistant = mkAssistant('streaming', undefined);
    const result = computeCanonical(assistant, extractRawBlocks(assistant.raw), 'streaming', '');
    expect(result.nextText).toBe('streaming');
  });

  it('merges thinking from backend when it exceeds snapshot', () => {
    const assistant = mkAssistant('text', {
      message: {
        content: [
          { type: 'thinking', thinking: 'longer backend thinking content' },
          { type: 'text', text: 'text' },
        ],
      },
    });
    const result = computeCanonical(assistant, extractRawBlocks(assistant.raw), 'text', 'short');
    expect(result.nextThinking).toBe('longer backend thinking content');
  });

  it('preserves streaming thinking when it exceeds backend', () => {
    const assistant = mkAssistant('text', {
      message: {
        content: [
          { type: 'thinking', thinking: 'short' },
          { type: 'text', text: 'text' },
        ],
      },
    });
    const result = computeCanonical(
      assistant, extractRawBlocks(assistant.raw), 'text', 'longer streaming thinking',
    );
    expect(result.nextThinking).toBe('longer streaming thinking');
  });

  it('returns assistant with updated content', () => {
    const assistant = mkAssistant('old', {
      message: { content: [{ type: 'text', text: 'new longer text' }] },
    });
    const result = computeCanonical(assistant, extractRawBlocks(assistant.raw), 'old', '');
    expect(result.assistant.content).toBe('new longer text');
  });

  it('handles legacy thinking blocks with text field instead of thinking field', () => {
    const assistant = mkAssistant('content', {
      message: {
        content: [
          { type: 'thinking', text: 'legacy thinking via text field' },
          { type: 'text', text: 'content' },
        ],
      },
    });
    const result = computeCanonical(assistant, extractRawBlocks(assistant.raw), 'content', '');
    expect(result.nextThinking).toBe('legacy thinking via text field');
  });

  it('produces identical results when called twice with same inputs (StrictMode safety)', () => {
    const assistant = mkAssistant('text', {
      message: {
        content: [
          { type: 'thinking', thinking: 'think' },
          { type: 'text', text: 'longer text content' },
        ],
      },
    });
    const blocks = extractRawBlocks(assistant.raw);
    const r1 = computeCanonical(assistant, blocks, 'text', 'think');
    const r2 = computeCanonical(assistant, blocks, 'text', 'think');
    expect(r1.nextText).toBe(r2.nextText);
    expect(r1.nextThinking).toBe(r2.nextThinking);
    expect(r1.assistant.content).toBe(r2.assistant.content);
  });
});

// ---------------------------------------------------------------------------
// getContentHash
// ---------------------------------------------------------------------------
describe('getContentHash', () => {
  it('returns "empty" for empty string', () => {
    expect(getContentHash('')).toBe('empty');
  });

  it('returns full text for short content (<=100 chars)', () => {
    expect(getContentHash('hello')).toBe('5:hello');
  });

  it('returns length:hash for long content (>100 chars)', () => {
    const long = 'a'.repeat(101);
    const hash = getContentHash(long);
    expect(hash).toMatch(/^101:[0-9a-f]+$/);
  });

  it('different long strings produce different hashes', () => {
    const a = 'a'.repeat(101);
    const b = 'b'.repeat(101);
    expect(getContentHash(a)).not.toBe(getContentHash(b));
  });

  it('same long string is deterministic', () => {
    const s = 'x'.repeat(200);
    expect(getContentHash(s)).toBe(getContentHash(s));
  });

  it('returns full text at exactly 100 chars (boundary)', () => {
    const exact = 'z'.repeat(100);
    expect(getContentHash(exact)).toBe(`100:${exact}`);
  });

  it('returns hash at 101 chars (boundary)', () => {
    const over = 'z'.repeat(101);
    expect(getContentHash(over)).toMatch(/^101:[0-9a-f]+$/);
  });

  it('detects suffix changes in long content', () => {
    const base = 'a'.repeat(100);
    const a = base + 'X';
    const b = base + 'Y';
    expect(getContentHash(a)).not.toBe(getContentHash(b));
  });
});

// ---------------------------------------------------------------------------
// getStructuralBlockSignature
// ---------------------------------------------------------------------------
describe('getStructuralBlockSignature', () => {
  it('returns "invalid" for null', () => {
    expect(getSig(null)).toBe('invalid');
  });

  it('returns "invalid" for undefined', () => {
    expect(getSig(undefined)).toBe('invalid');
  });

  it('generates thinking signature with hash for long content', () => {
    const block = { type: 'thinking', thinking: 'a'.repeat(200) } as ContentBlock;
    const sig = getSig(block);
    expect(sig).toMatch(/^thinking\|\|200:[0-9a-f]+$/);
  });

  it('generates text signature with hash for long content', () => {
    const block = { type: 'text', text: 'b'.repeat(150) } as ContentBlock;
    const sig = getSig(block);
    expect(sig).toMatch(/^text\|150:[0-9a-f]+$/);
  });

  it('generates text signature with full content for short text', () => {
    const block = { type: 'text', text: 'hello' } as ContentBlock;
    expect(getSig(block)).toBe('text|5:hello');
  });

  it('generates tool_use signature', () => {
    const block = { type: 'tool_use', id: 'abc', name: 'read' } as ContentBlock;
    expect(getSig(block)).toBe('tool_use|abc|read');
  });

  it('generates tool_result signature', () => {
    const block = { type: 'tool_result', tool_use_id: 'abc', content: 'ok' } as ContentBlock;
    expect(getSig(block)).toBe('tool_result|abc|false');
  });

  it('generates tool_result signature with is_error=true', () => {
    const block = { type: 'tool_result', tool_use_id: 'abc', content: 'err', is_error: true } as ContentBlock;
    expect(getSig(block)).toBe('tool_result|abc|true');
  });

  it('uses type + identity fields for unknown block types', () => {
    const block = { type: 'custom', foo: 'bar' } as ContentBlock;
    const sig = getSig(block);
    // N1: lightweight signature using type + id/name fields
    expect(sig).toBe('custom||');
  });

  it('uses type + id + name for unknown block types with those fields', () => {
    const block = { type: 'custom', id: 'c1', name: 'MyBlock' } as ContentBlock;
    const sig = getSig(block);
    expect(sig).toBe('custom|c1|MyBlock');
  });
});

// ---------------------------------------------------------------------------
// hasStructuralBlockChange
// ---------------------------------------------------------------------------
describe('hasStructuralBlockChange', () => {
  it('returns true when lengths differ', () => {
    const a = [{ type: 'text', text: 'a' }] as ContentBlock[];
    const b = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] as ContentBlock[];
    expect(hasChange(a, b)).toBe(true);
  });

  it('returns false when blocks are identical', () => {
    const blocks = [
      { type: 'thinking', thinking: 'think' },
      { type: 'text', text: 'text' },
    ] as ContentBlock[];
    expect(hasChange(blocks, [...blocks])).toBe(false);
  });

  it('detects change in thinking content', () => {
    const a = [{ type: 'thinking', thinking: 'v1' }] as ContentBlock[];
    const b = [{ type: 'thinking', thinking: 'v2' }] as ContentBlock[];
    expect(hasChange(a, b)).toBe(true);
  });

  it('detects change in text content', () => {
    const a = [{ type: 'text', text: 'v1' }] as ContentBlock[];
    const b = [{ type: 'text', text: 'v2' }] as ContentBlock[];
    expect(hasChange(a, b)).toBe(true);
  });

  it('returns false for two empty arrays', () => {
    expect(hasChange([], [])).toBe(false);
  });

  it('detects structural change when an earlier assistant fragment gains a tool_use block', () => {
    const previous = [
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'final' },
    ] as ContentBlock[];
    const next = [
      { type: 'thinking', thinking: 'plan' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'text', text: 'final' },
    ] as ContentBlock[];
    expect(hasChange(previous, next)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectAssistantBlocks
// ---------------------------------------------------------------------------
describe('collectAssistantBlocks', () => {
  it('collects blocks from all assistant messages in order', () => {
    const messages = [
      {
        type: 'assistant',
        raw: { message: { content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', id: 'tool-1', name: 'Read' }] } },
      },
      {
        type: 'user',
        raw: { message: { content: [{ type: 'text', text: 'ignored' }] } },
      },
      {
        type: 'assistant',
        raw: { message: { content: [{ type: 'text', text: 'answer' }] } },
      },
    ] as ClaudeMessage[];

    expect(collectAssistantBlocks(messages, extractRawBlocks)).toEqual([
      { type: 'thinking', thinking: 'plan' },
      { type: 'tool_use', id: 'tool-1', name: 'Read' },
      { type: 'text', text: 'answer' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// extractCanonicalTextFromBlocks / extractCanonicalThinkingFromBlocks
// ---------------------------------------------------------------------------
describe('extractCanonicalTextFromBlocks', () => {
  it('extracts text from text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ];
    expect(extractText(blocks)).toBe('hello world');
  });

  it('ignores thinking blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'think' },
      { type: 'text', text: 'only text' },
    ];
    expect(extractText(blocks)).toBe('only text');
  });

  it('returns empty string when no text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'think' },
    ];
    expect(extractText(blocks)).toBe('');
  });
});

describe('extractCanonicalThinkingFromBlocks', () => {
  it('extracts thinking from thinking field', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'thought' },
    ];
    expect(extractThinking(blocks)).toBe('thought');
  });

  it('falls back to text field for legacy format', () => {
    const blocks = [
      { type: 'thinking', text: 'legacy thought' },
    ] as ContentBlock[];
    expect(extractThinking(blocks)).toBe('legacy thought');
  });

  it('joins multiple thinking blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'a' },
      { type: 'thinking', thinking: 'b' },
    ];
    expect(extractThinking(blocks)).toBe('ab');
  });

  it('normalizes CRLF in thinking content', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'line1\r\nline2' },
    ];
    expect(extractThinking(blocks)).toBe('line1\nline2');
  });
});
