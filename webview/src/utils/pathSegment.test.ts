import { looksLikePathSegment } from './pathSegment.js';

describe('looksLikePathSegment', () => {
  it('accepts segments containing a path separator', () => {
    expect(looksLikePathSegment('docs\\chapter6')).toBe(true);
    expect(looksLikePathSegment('docs/chapter6')).toBe(true);
  });

  it('accepts segments ending with a file extension (filename with spaces)', () => {
    expect(looksLikePathSegment('框架开发实践.md')).toBe(true);
    expect(looksLikePathSegment('my file.ts')).toBe(true);
  });

  it('strips a trailing #L line marker before checking the extension', () => {
    expect(looksLikePathSegment('框架开发实践.md#L10-20')).toBe(true);
    expect(looksLikePathSegment('框架开发实践.md#L10')).toBe(true);
  });

  it('rejects plain words that are not path-like', () => {
    expect(looksLikePathSegment('and')).toBe(false);
    expect(looksLikePathSegment('中查看')).toBe(false);
    expect(looksLikePathSegment('')).toBe(false);
  });
});
