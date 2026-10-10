import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { mergeCodexHistory } from './codexHistoryMerge';

const row = (id: string, content = 'same'): ClaudeMessage => ({ type: 'user', content,
  timestamp: '2026-10-02T00:00:00Z', raw: { uuid: id } });

describe('native history identity merging', () => {
  it('deduplicates an overlapping boundary and retains distinct identical prompts', () => {
    expect(mergeCodexHistory([row('1'), row('2')], [row('2', 'updated'), row('3')]).map((message) => message.content))
      .toEqual(['same', 'updated', 'same']);
  });
  it('keeps an uncertain local submission missing from the page', () => {
    const uncertain = { ...row('uncertain'), raw: { clientMessageId: 'client' }, isOptimistic: true };
    expect(mergeCodexHistory([row('old')], [uncertain])).toHaveLength(2);
  });
  it('reconciles a native confirmation with the same client identity', () => {
    const optimistic = { ...row('local'), raw: { clientMessageId: 'client' } };
    const native = { ...row('native'), raw: { clientMessageId: 'client', codexItemId: 'item' } };
    expect(mergeCodexHistory([optimistic], [native])).toEqual([native]);
    expect(mergeCodexHistory([native], [optimistic])).toEqual([native]);
  });
});
