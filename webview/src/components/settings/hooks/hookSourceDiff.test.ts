import { describe, expect, it } from 'vitest';
import { buildHookSourceDiff, preserveHookLineEndings } from './hookSourceDiff';

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
      { type: 'removed', text: 'one [LF]', oldLine: 1 },
      { type: 'added', text: 'one [EOF]', newLine: 1 },
      { type: 'removed', text: 'two', oldLine: 2 },
      { type: 'removed', text: '', oldLine: 3 },
    ]);
  });

  it('aligns context after an insertion longer than eighty lines', () => {
    const original = 'first\nanchor\nlast';
    const inserted = Array.from({ length: 100 }, (_, index) => `inserted-${index}`).join('\n');
    const diff = buildHookSourceDiff(original, `first\n${inserted}\nanchor\nlast`);
    expect(diff.filter(line => line.type === 'removed')).toHaveLength(0);
    expect(diff.filter(line => line.type === 'added')).toHaveLength(100);
    expect(diff.find(line => line.text === 'anchor')).toMatchObject({ type: 'context', oldLine: 2, newLine: 102 });
  });

  it('makes line ending conversion visible', () => {
    const diff = buildHookSourceDiff('one\r\ntwo\r\n', 'one\ntwo\n');
    expect(diff.filter(line => line.type === 'removed').map(line => line.text)).toEqual(['one [CRLF]', 'two [CRLF]']);
    expect(diff.filter(line => line.type === 'added').map(line => line.text)).toEqual(['one [LF]', 'two [LF]']);
  });

  it('retains CRLF when textarea input edits a line', () => {
    expect(preserveHookLineEndings('one\nchanged\n', 'one\r\ntwo\r\n')).toBe('one\r\nchanged\r\n');
  });

  it('retains mixed separators on unchanged lines and an intentional missing final newline', () => {
    expect(preserveHookLineEndings('one\ntwo\nchanged', 'one\r\ntwo\nthree\r\n')).toBe('one\r\ntwo\nchanged');
  });
});
