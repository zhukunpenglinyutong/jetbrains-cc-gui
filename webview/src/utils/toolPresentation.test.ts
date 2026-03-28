import { describe, expect, it } from 'vitest';
import type { ToolResultBlock } from '../types';
import { getToolEditCount, getToolLineInfo, resolveToolTarget, summarizeToolCommand } from './toolPresentation';

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

  it('falls back to unified diff hunk line info from tool result text', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      content: `@@ -19,2 +19,2 @@\n-old line\n+new line`,
    };

    expect(getToolLineInfo({ file_path: 'text.md' }, undefined, result)).toEqual({ start: 19, end: 20 });
  });

  it('uses the actual inserted line range instead of the full hunk context', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      content: `@@ -29,5 +29,6 @@\n line 29\n line 30\n line 31\n line 32\n+inserted line 33\n line 33`,
    };

    expect(getToolLineInfo({ file_path: 'text.md' }, undefined, result)).toEqual({ start: 33 });
  });

  it('uses the nearest surviving line for deletion-only hunks with context', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      content: `@@ -19,5 +19,4 @@\n line 19\n line 20\n-line 21\n line 22\n line 23`,
    };

    expect(getToolLineInfo({ file_path: 'text.md' }, undefined, result)).toEqual({ start: 21 });
  });

  it('supports insertion-only hunks from tool result text', () => {
    const result: ToolResultBlock = {
      type: 'tool_result',
      content: `@@ -0,0 +7,3 @@\n+alpha\n+beta\n+gamma`,
    };

    expect(getToolLineInfo({ file_path: 'text.md' }, undefined, result)).toEqual({ start: 7, end: 9 });
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
});
