import { describe, expect, it } from 'vitest';
import { parseWorkspaceDiffFiles, parseWorkspaceDiffSnapshot } from './workspaceDiffFiles';

const MODIFY_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,3 @@',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  ' context',
].join('\n');

const MIXED_DIFF = [
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new.ts',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  'diff --git a/binary.bin b/binary.bin',
  'index 0000000..1111111 100644',
  'GIT binary patch',
  'literal 10',
  'diff --git a/old.ts b/old.ts',
  'similarity index 90%',
  'rename from old.ts',
  'rename to renamed.ts',
].join('\n');

describe('parseWorkspaceDiffFiles', () => {
  it('extracts modify entries and ignores hunk bodies that look like headers', () => {
    expect(parseWorkspaceDiffFiles(MODIFY_DIFF)).toEqual([
      { path: 'src/app.ts', kind: 'modify', binary: false },
    ]);
  });

  it('classifies add, delete, binary and rename entries', () => {
    expect(parseWorkspaceDiffFiles(MIXED_DIFF)).toEqual([
      { path: 'new.ts', kind: 'add', binary: false },
      { path: 'gone.ts', kind: 'delete', binary: false },
      { path: 'binary.bin', kind: 'modify', binary: true },
      { path: 'renamed.ts', kind: 'rename', binary: false },
    ]);
  });

  it('decodes the UTF-8 octets Git quotes in added and deleted file names', () => {
    const quotedPath = String.raw`"\345\256\241\346\237\245 \350\257\264\346\230\216.txt"`;
    const oldPath = `"a/${quotedPath.slice(1)}`;
    const newPath = `"b/${quotedPath.slice(1)}`;
    const diff = [
      `diff --git ${oldPath} ${newPath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ ${newPath}\t`,
      '@@ -0,0 +1 @@',
      '+review evidence',
      `diff --git ${oldPath} ${newPath}`,
      'deleted file mode 100644',
      `--- ${oldPath}`,
      '+++ /dev/null',
    ].join('\n');
    expect(parseWorkspaceDiffFiles(diff)).toEqual([
      { path: '审查 说明.txt', kind: 'add', binary: false },
      { path: '审查 说明.txt', kind: 'delete', binary: false },
    ]);
  });

  it('decodes quoted binary and rename headers without treating their escapes as syntax', () => {
    const binaryPath = String.raw`"b/assets/\350\257\264\346\230\216.png"`;
    const renamedPath = String.raw`"docs/\350\257\264\346\230\216\"\\\n.md"`;
    const diff = [
      `diff --git "a/assets/\\350\\257\\264\\346\\230\\216.png" ${binaryPath}`,
      'GIT binary patch',
      'literal 10',
      'diff --git a/docs/before.md "b/docs/after\\\"\\\\\\n.md"',
      'similarity index 100%',
      'rename from docs/before.md',
      `rename to ${renamedPath}`,
    ].join('\n');
    expect(parseWorkspaceDiffFiles(diff)).toEqual([
      { path: 'assets/说明.png', kind: 'modify', binary: true },
      { path: 'docs/说明"\\\n.md', kind: 'rename', binary: false },
    ]);
  });

  it('retains spaces and literal Unicode when Git quotes only special characters', () => {
    const diff = [
      'diff --git a/docs/my report.md b/docs/my report.md',
      '--- a/docs/my report.md',
      '+++ b/docs/my report.md\t',
      'diff --git "a/docs/说明\\t.md" "b/docs/说明\\t.md"',
      'GIT binary patch',
    ].join('\n');
    expect(parseWorkspaceDiffFiles(diff)).toEqual([
      { path: 'docs/my report.md', kind: 'modify', binary: false },
      { path: 'docs/说明\t.md', kind: 'modify', binary: true },
    ]);
  });

  it('returns empty collections for absent diffs', () => {
    expect(parseWorkspaceDiffFiles('')).toEqual([]);
    expect(parseWorkspaceDiffSnapshot({ untracked: ['log.txt'] })).toEqual({
      staged: [],
      unstaged: [],
      untracked: ['log.txt'],
    });
    expect(parseWorkspaceDiffSnapshot({ untracked: 'not-an-array' }).untracked).toEqual([]);
  });
});
