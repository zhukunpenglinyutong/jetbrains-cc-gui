import {
  parseExplicitFileReferences,
  parseLineFileReference,
  registerAbsoluteFileReference,
  registerLineFileReference,
} from './fileReferences.js';

describe('file reference helpers', () => {
  it('parses Windows paths with spaces and multiple explicit references', () => {
    expect(parseExplicitFileReferences(
      '@C:\\Program Files\\demo\\view file.xml @D:\\workspace\\index.vue'
    )).toEqual([
      'C:\\Program Files\\demo\\view file.xml',
      'D:\\workspace\\index.vue',
    ]);
  });

  it('supports Unix and UNC absolute paths', () => {
    expect(parseExplicitFileReferences('@\\\\server\\share\\view file.xml')).toEqual([
      '\\\\server\\share\\view file.xml',
    ]);
    expect(parseExplicitFileReferences('@/workspace/src/App.ts')).toEqual([
      '/workspace/src/App.ts',
    ]);
  });

  it('rejects mixed text, email-like text, and annotations', () => {
    expect(parseExplicitFileReferences('See @/workspace/src/App.ts')).toBeNull();
    expect(parseExplicitFileReferences('@C:\\workspace\\view.xml please review')).toBeNull();
    expect(parseExplicitFileReferences('@/workspace/src/App.vue explain this file')).toBeNull();
    expect(parseExplicitFileReferences('@user@example.com')).toBeNull();
    expect(parseExplicitFileReferences('@GetMapping("/api")')).toBeNull();
    expect(parseExplicitFileReferences('@C:\\workspace\\view.xml\nconst value = 1')).toBeNull();
  });

  it('registers full paths and strict line references for exact rendering', () => {
    const mapping = new Map<string, string>();

    expect(registerAbsoluteFileReference(mapping, 'C:\\Program Files\\view file.xml'))
      .toBe('C:\\Program Files\\view file.xml');
    expect(mapping.get('C:\\Program Files\\view file.xml'))
      .toBe('C:\\Program Files\\view file.xml');
    expect(mapping.get('view file.xml')).toBe('C:\\Program Files\\view file.xml');

    expect(parseLineFileReference('@C:\\Program Files\\Main.java#L10-12')).toEqual({
      path: 'C:\\Program Files\\Main.java',
      reference: 'C:\\Program Files\\Main.java#L10-12',
    });
    expect(registerLineFileReference(mapping, '@C:\\Program Files\\Main.java#L10-12'))
      .toBe('C:\\Program Files\\Main.java#L10-12');
    expect(mapping.get('C:\\Program Files\\Main.java#L10-12'))
      .toBe('C:\\Program Files\\Main.java');
  });

  it('keeps an at sign inside a structured absolute path', () => {
    const mapping = new Map<string, string>();
    const filePath = 'C:\\workspace\\user@example.vue';

    expect(registerAbsoluteFileReference(mapping, filePath)).toBe(filePath);
    expect(mapping.get('user@example.vue')).toBe(filePath);
  });

  it('rejects invalid zero and reversed line ranges', () => {
    expect(parseLineFileReference('@C:\\workspace\\Main.java#L0')).toBeNull();
    expect(parseLineFileReference('@C:\\workspace\\Main.java#L12-10')).toBeNull();
  });
});
