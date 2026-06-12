import { describe, expect, it } from 'vitest';
import { getFileIconKind } from './fileIconKind';

describe('getFileIconKind', () => {
  it('classifies common code extensions as "code"', () => {
    expect(getFileIconKind('index.ts')).toBe('code');
    expect(getFileIconKind('Component.tsx')).toBe('code');
    expect(getFileIconKind('main.go')).toBe('code');
    expect(getFileIconKind('styles.less')).toBe('code');
    expect(getFileIconKind('config.json')).toBe('code');
  });

  it('classifies non-code extensions as "file"', () => {
    expect(getFileIconKind('notes.txt')).toBe('file');
    expect(getFileIconKind('image.png')).toBe('file');
    expect(getFileIconKind('archive.zip')).toBe('file');
    expect(getFileIconKind('movie.mp4')).toBe('file');
  });

  it('matches the extension case-insensitively', () => {
    expect(getFileIconKind('DATA.JSON')).toBe('code');
    expect(getFileIconKind('Script.PY')).toBe('code');
    expect(getFileIconKind('Photo.PNG')).toBe('file');
  });

  it('extracts the extension from full paths (forward and back slashes)', () => {
    expect(getFileIconKind('/usr/local/src/main.rs')).toBe('code');
    expect(getFileIconKind('src/components/App.tsx')).toBe('code');
    expect(getFileIconKind('C:\\repo\\src\\app\\index.less')).toBe('code');
    expect(getFileIconKind('C:\\Users\\me\\notes.txt')).toBe('file');
  });

  it('treats files without an extension as "file"', () => {
    expect(getFileIconKind('Makefile')).toBe('file');
    expect(getFileIconKind('README')).toBe('file');
    expect(getFileIconKind('/etc/hosts')).toBe('file');
  });

  it('treats a trailing dot (no real extension) as "file"', () => {
    expect(getFileIconKind('weird.')).toBe('file');
  });

  it('treats dotfiles without a further extension as "file"', () => {
    expect(getFileIconKind('.gitignore')).toBe('file');
    expect(getFileIconKind('.env')).toBe('file');
  });

  it('uses the last extension for multi-dot names', () => {
    expect(getFileIconKind('archive.tar.gz')).toBe('file');
    expect(getFileIconKind('component.test.ts')).toBe('code');
  });
});
