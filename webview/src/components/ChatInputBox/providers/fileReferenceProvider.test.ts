import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  filterFiles,
  fileMatchesQuery,
  fuzzySubsequenceMatch,
  isAbsoluteLikePath,
  parseQuery,
  resetFileReferenceState,
  scoreFileMatch,
  fileReferenceProvider,
} from './fileReferenceProvider';
import type { FileItem } from '../types';

function file(partial: Partial<FileItem> & { name: string; path: string }): FileItem {
  return {
    type: 'file',
    absolutePath: partial.absolutePath ?? `/project/${partial.path}`,
    ...partial,
  } as FileItem;
}

describe('fileReferenceProvider matching', () => {
  beforeEach(() => {
    resetFileReferenceState();
    delete window.onFileListResult;
    delete window.sendToJava;
  });

  it('parseQuery splits path and search keyword', () => {
    expect(parseQuery('')).toEqual({ currentPath: '', searchQuery: '' });
    expect(parseQuery('src/')).toEqual({ currentPath: 'src/', searchQuery: '' });
    expect(parseQuery('src/com')).toEqual({ currentPath: 'src/', searchQuery: 'com' });
    expect(parseQuery('build')).toEqual({ currentPath: '', searchQuery: 'build' });
  });

  it('detects absolute-like paths so project root names do not over-match', () => {
    expect(isAbsoluteLikePath('/Users/me/jetbrains-cc-gui/Dockerfile')).toBe(true);
    expect(isAbsoluteLikePath('C:\\Users\\me\\file.ts')).toBe(true);
    expect(isAbsoluteLikePath('Dockerfile')).toBe(false);
    expect(isAbsoluteLikePath('src/main/Dockerfile')).toBe(false);
  });

  it('supports subsequence fuzzy match', () => {
    expect(fuzzySubsequenceMatch('build.gradle', 'bg')).toBe(true);
    expect(fuzzySubsequenceMatch('slashcommandregistry.java', 'scr')).toBe(true);
    expect(fuzzySubsequenceMatch('dockerfile', 'xyz')).toBe(false);
  });

  it('does not match query against absolute paths', () => {
    const f = file({
      name: 'Dockerfile',
      path: '/Users/zhukunpeng/Desktop/CC GUI 项目/jetbrains-cc-gui/Dockerfile',
    });
    expect(fileMatchesQuery(f, 'b')).toBe(false);
    expect(scoreFileMatch(f, 'b')).toBe(0);
  });

  it('matches filename substring and ranks prefix higher', () => {
    const build = file({ name: 'build.gradle', path: 'build.gradle' });
    const contributing = file({ name: 'CONTRIBUTING.md', path: 'CONTRIBUTING.md' });
    const docker = file({ name: 'Dockerfile', path: 'Dockerfile' });

    expect(fileMatchesQuery(build, 'b')).toBe(true);
    expect(fileMatchesQuery(contributing, 'b')).toBe(true);
    expect(fileMatchesQuery(docker, 'b')).toBe(false);

    expect(scoreFileMatch(build, 'b')).toBeGreaterThan(scoreFileMatch(contributing, 'b'));
  });

  it('filterFiles drops non-matches and ranks by score', () => {
    const files = [
      file({ name: 'Dockerfile', path: 'Dockerfile' }),
      file({ name: 'CONTRIBUTING.md', path: 'CONTRIBUTING.md' }),
      file({ name: 'build.gradle', path: 'build.gradle' }),
      file({ name: 'SlashCommandRegistry.java', path: 'src/SlashCommandRegistry.java' }),
      file({
        name: 'skills-lock.json',
        path: '/Users/me/jetbrains-cc-gui/skills-lock.json',
      }),
    ];

    const result = filterFiles(files, 'b');
    const names = result.map(f => f.name);

    expect(names).toContain('build.gradle');
    expect(names).toContain('CONTRIBUTING.md');
    expect(names).not.toContain('Dockerfile');
    expect(names).not.toContain('SlashCommandRegistry.java');
    expect(names).not.toContain('skills-lock.json');
    expect(names[0]).toBe('build.gradle');
  });

  it('ignores stale list_files responses when requestId does not match', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;

    const controller = new AbortController();
    const promise = fileReferenceProvider('b', controller.signal);

    expect(sendToJava).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(sendToJava.mock.calls[0][0]).replace(/^list_files:/, ''));
    expect(payload.query).toBe('b');
    expect(typeof payload.requestId).toBe('number');

    // Stale empty-query response must not resolve the active waiter
    window.onFileListResult?.(JSON.stringify({
      requestId: payload.requestId - 1,
      files: [
        { name: 'Dockerfile', path: 'Dockerfile', type: 'file' },
        { name: 'skills-lock.json', path: 'skills-lock.json', type: 'file' },
      ],
    }));

    // Correct response for "b"
    window.onFileListResult?.(JSON.stringify({
      requestId: payload.requestId,
      files: [
        { name: 'Dockerfile', path: 'Dockerfile', type: 'file' },
        { name: 'build.gradle', path: 'build.gradle', type: 'file' },
        { name: 'CONTRIBUTING.md', path: 'CONTRIBUTING.md', type: 'file' },
      ],
    }));

    const results = await promise;
    const names = results.map(f => f.name);
    expect(names).toEqual(['build.gradle', 'CONTRIBUTING.md']);
  });

  it('keeps backend hits that match on basename when requestId is missing', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;

    const controller = new AbortController();
    const promise = fileReferenceProvider('b', controller.signal);

    window.onFileListResult?.(JSON.stringify({
      files: [
        { name: 'Dockerfile', path: 'Dockerfile', type: 'file' },
        { name: 'build.gradle', path: 'build.gradle', type: 'file' },
        { name: 'SlashCommandRegistry.java', path: 'src/main/SlashCommandRegistry.java', type: 'file' },
      ],
    }));

    const results = await promise;
    expect(results.map(f => f.name)).toEqual(['build.gradle']);
  });

  it('does not empty the list when backend only returned basename matches mixed with noise', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;

    const controller = new AbortController();
    const promise = fileReferenceProvider('build', controller.signal);

    const payload = JSON.parse(String(sendToJava.mock.calls[0][0]).replace(/^list_files:/, ''));
    window.onFileListResult?.(JSON.stringify({
      requestId: payload.requestId,
      files: [
        { name: 'build.gradle', path: 'build.gradle', type: 'file' },
        { name: 'gradlew.bat', path: 'gradlew.bat', type: 'file' },
      ],
    }));

    const results = await promise;
    expect(results.map(f => f.name)).toContain('build.gradle');
    expect(results.length).toBeGreaterThan(0);
  });

  it('hard-drops absolute-path-only false positives instead of soft-fallback', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;

    const controller = new AbortController();
    const promise = fileReferenceProvider('b', controller.signal);

    const payload = JSON.parse(String(sendToJava.mock.calls[0][0]).replace(/^list_files:/, ''));
    // Backend over-matched via "jetbrains" in absolute path (legacy bug)
    window.onFileListResult?.(JSON.stringify({
      requestId: payload.requestId,
      files: [
        {
          name: 'Dockerfile',
          path: '/Users/me/jetbrains-cc-gui/Dockerfile',
          absolutePath: '/Users/me/jetbrains-cc-gui/Dockerfile',
          type: 'file',
        },
        {
          name: 'skills-lock.json',
          path: '/Users/me/jetbrains-cc-gui/skills-lock.json',
          absolutePath: '/Users/me/jetbrains-cc-gui/skills-lock.json',
          type: 'file',
        },
        {
          name: 'build.gradle',
          path: 'build.gradle',
          absolutePath: '/Users/me/jetbrains-cc-gui/build.gradle',
          type: 'file',
        },
        {
          name: 'CONTRIBUTING.md',
          path: 'CONTRIBUTING.md',
          absolutePath: '/Users/me/jetbrains-cc-gui/CONTRIBUTING.md',
          type: 'file',
        },
      ],
    }));

    const results = await promise;
    const names = results.map(f => f.name);
    expect(names).toContain('build.gradle');
    expect(names).toContain('CONTRIBUTING.md');
    expect(names).not.toContain('Dockerfile');
    expect(names).not.toContain('skills-lock.json');
  });

  it('returns empty when nothing matches query (no soft fallback to noise)', async () => {
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;

    const controller = new AbortController();
    const promise = fileReferenceProvider('zzzz-no-match', controller.signal);

    const payload = JSON.parse(String(sendToJava.mock.calls[0][0]).replace(/^list_files:/, ''));
    window.onFileListResult?.(JSON.stringify({
      requestId: payload.requestId,
      files: [
        { name: 'Dockerfile', path: 'Dockerfile', type: 'file' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ],
    }));

    const results = await promise;
    expect(results).toEqual([]);
  });
});
