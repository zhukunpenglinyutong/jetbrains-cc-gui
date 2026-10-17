import { describe, expect, it } from 'vitest';
import { readPatchFiles } from './codexPatch';

describe('patch display', () => {
  it('accepts the input argument used by function-call apply_patch', () => {
    const files = readPatchFiles({ input: '*** Begin Patch\n*** Add File: a.ts\n+const value = "literal";\n*** End Patch' });
    expect(files.map(file => file.path)).toEqual(['a.ts']);
    expect(files[0].diff.additions).toBe(1);
  });
  it('keeps malformed or future changes in the generic card instead of silently dropping files', () => {
    const valid = { path: 'a.ts', kind: 'add', diff: '+a' };
    for (const invalid of [null, { kind: 'delete', diff: '-b' }, { path: 'b.ts', kind: 'futureKind' }]) {
      expect(readPatchFiles({ changes: [valid, invalid] })).toEqual([]);
    }
    expect(readPatchFiles({ patch: '*** Begin Patch\n*** Update File:   \n@@\n+x\n*** End Patch' })).toEqual([]);
  });
  it('preserves all file changes, move targets and literal patch lines', () => {
    const files = readPatchFiles({ patch: '*** Begin Patch\n*** Add File: a.txt\n+++literal\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n before\n-old\n+new\n*** Delete File: gone.txt\n*** End Patch' });
    expect(files.map((file) => [file.path, file.kind, file.movePath])).toEqual([
      ['a.txt', 'add', undefined], ['old.txt', 'update', 'new.txt'], ['gone.txt', 'delete', undefined],
    ]);
    expect(files[0].diff.lines).toEqual([{ type: 'added', content: '++literal' }]);
    expect(files[1].diff.additions).toBe(1);
    expect(files[1].diff.deletions).toBe(1);
    expect(files[2].diff.lines).toHaveLength(0);
  });
  it('uses native unified hunks without inventing full file contents', () => {
    const [file] = readPatchFiles({ changes: [{ path: 'a.ts', kind: { type: 'update', movePath: 'b.ts' },
      diff: '--- a/a.ts\n+++ b/b.ts\n@@ -10,1 +10,1 @@\n-old\n+new' }] });
    expect(file.movePath).toBe('b.ts');
    expect(file.diff.lines).toEqual([
      { type: 'unchanged', content: '@@ -10,1 +10,1 @@' },
      { type: 'deleted', content: 'old' }, { type: 'added', content: 'new' },
    ]);
    expect(readPatchFiles({ patch: 'await tools.apply_patch(patch)' })).toEqual([]);
  });
  it('resets hunk state at each file header in a multi-file unified diff', () => {
    const [first, second] = readPatchFiles({ changes: [
      { path: 'a.ts', kind: 'update', diff: 'diff --git a/a.ts b/a.ts\nindex 111..222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-old a\n+new a' },
      { path: 'b.ts', kind: 'update', diff: 'diff --git a/b.ts b/b.ts\nindex 333..444 100644\n--- a/b.ts\n+++ b/b.ts\n@@ -1,1 +1,1 @@\n-old b\n+new b' },
    ] });
    expect(first.diff.additions).toBe(1);
    expect(first.diff.deletions).toBe(1);
    expect(second.diff.additions).toBe(1);
    expect(second.diff.deletions).toBe(1);
    expect(second.diff.lines).toEqual([
      { type: 'unchanged', content: '@@ -1,1 +1,1 @@' },
      { type: 'deleted', content: 'old b' }, { type: 'added', content: 'new b' },
    ]);
  });
});
