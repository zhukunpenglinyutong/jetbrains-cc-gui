import { describe, expect, it } from 'vitest';
import { buildHookSourceDiff } from './hookSourceDiff';

describe('buildHookSourceDiff', () => {
  it('marks inserted lines without changing context line numbers', () => {
    expect(buildHookSourceDiff('one\ntwo', 'one\nnew\ntwo')).toEqual([
      { type: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { type: 'added', text: 'new', newLine: 2 },
      { type: 'context', text: 'two', oldLine: 2, newLine: 3 },
    ]);
  });

  it('marks replacements as a removal followed by an addition', () => {
    expect(buildHookSourceDiff('old', 'new')).toEqual([
      { type: 'removed', text: 'old', oldLine: 1 },
      { type: 'added', text: 'new', newLine: 1 },
    ]);
  });

  it('handles deleted and empty trailing lines', () => {
    expect(buildHookSourceDiff('one\ntwo\n', 'one')).toEqual([
      { type: 'context', text: 'one', oldLine: 1, newLine: 1 },
      { type: 'removed', text: 'two', oldLine: 2 },
      { type: 'removed', text: '', oldLine: 3 },
    ]);
  });
});
