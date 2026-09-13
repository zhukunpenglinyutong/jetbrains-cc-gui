import { describe, expect, it } from 'vitest';
import { getToolLineInfo, resolveToolTarget, summarizeToolCommand } from './toolPresentation';

describe('toolPresentation', () => {
  it('relativizes display path to workdir and strips line suffix for open path', () => {
    const target = resolveToolTarget({
      command: "sed -n '10,20p' /repo/src/App.tsx",
      workdir: '/repo',
    }, 'shell_command');

    expect(target).toMatchObject({
      rawPath: '/repo/src/App.tsx:10-20',
      openPath: '/repo/src/App.tsx',
      displayPath: 'src/App.tsx:10-20',
      cleanFileName: 'App.tsx',
      isFile: true,
      isDirectory: false,
      lineStart: 10,
      lineEnd: 20,
    });
  });

  it('prefers structured line metadata over path suffix', () => {
    const target = resolveToolTarget({
      file_path: 'src/main.ts:1-10',
      offset: 19,
      limit: 5,
    }, 'read');

    expect(getToolLineInfo({
      file_path: 'src/main.ts:1-10',
      offset: 19,
      limit: 5,
    }, target)).toEqual({ start: 20, end: 24 });
  });

  it('summarizes shell-wrapped multiline commands like the TUI', () => {
    const summary = summarizeToolCommand("/bin/bash -lc 'set -o pipefail\ncargo test\n--all-features --quiet'");

    expect(summary).toBe('set -o pipefail ...');
  });

  it('keeps standard edit-file paths clickable without line suffixes', () => {
    const target = resolveToolTarget({
      file_path: '/repo/src/main.ts:3-8',
    }, 'edit');

    expect(target).toMatchObject({
      rawPath: '/repo/src/main.ts:3-8',
      openPath: '/repo/src/main.ts',
      displayPath: 'main.ts:3-8',
      cleanFileName: 'main.ts',
    });
  });

  it('relativizes display path when workdir is provided', () => {
    const target = resolveToolTarget({
      file_path: '/repo/src/main.ts:3-8',
      workdir: '/repo',
    }, 'edit');

    expect(target).toMatchObject({
      rawPath: '/repo/src/main.ts:3-8',
      openPath: '/repo/src/main.ts',
      displayPath: 'src/main.ts:3-8',
      cleanFileName: 'main.ts',
    });
  });
  it('truncates long display paths from the start with an ellipsis prefix', () => {
    const target = resolveToolTarget({
      file_path: '/repo/webview/src/components/ChatInputBox/selectors/useFileTagExtraction.ts',
      workdir: '/repo',
    }, 'read');

    expect(target?.displayPath).toBe('…/selectors/useFileTagExtraction.ts');
    expect(target?.cleanFileName).toBe('useFileTagExtraction.ts');
    expect(target?.openPath).toBe('/repo/webview/src/components/ChatInputBox/selectors/useFileTagExtraction.ts');
  });

  it('keeps a trailing separator when truncating long directory paths', () => {
    const target = resolveToolTarget({
      file_path: '/repo/webview/src/components/ChatInputBox/someVeryDeepFolderName/selectors/',
      workdir: '/repo',
    }, 'read');

    expect(target?.displayPath).toBe('…/someVeryDeepFolderName/selectors/');
    expect(target?.isDirectory).toBe(true);
  });

  it('leaves short display paths untouched', () => {
    const target = resolveToolTarget({
      file_path: '/repo/src/main.ts',
      workdir: '/repo',
    }, 'read');

    expect(target?.displayPath).toBe('src/main.ts');
  });
});
