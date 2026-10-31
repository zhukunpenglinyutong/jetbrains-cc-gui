import { describe, expect, it } from 'vitest';
import { readPatchFiles } from './codexPatch';

describe('patch display', () => {
  it('matches a native added Markdown file to its apply_patch history without reading bullets as deletions', () => {
    const lines = Array.from({ length: 312 }, (_, index) => index < 13 ? `- item ${index}` : `line ${index}`);
    const content = `${lines.join('\n')}\n`;
    const [native] = readPatchFiles({ changes: [{ path: 'plan.md', kind: { type: 'add' }, diff: content }] });
    const [history] = readPatchFiles({ patch: ['*** Begin Patch', '*** Add File: plan.md',
      ...lines.map(line => `+${line}`), '*** End Patch'].join('\n') });
    expect(native.diff).toEqual(history.diff);
    expect(native.diff.additions).toBe(312);
    expect(native.diff.deletions).toBe(0);
    expect(native.content).toBe(content);
  });

  it.each(['add', 'delete'] as const)('preserves literal diff markers in native %s file contents', (kind) => {
    const content = '- list item\r\n+literal\r\n--- heading\r\n+++ text\r\n@@ section\r\n\r\n\\ No newline at end of file';
    const [file] = readPatchFiles({ changes: [{ path: 'markers.md', kind, diff: content }] });
    expect(file.diff.lines).toEqual(content.replace(/\r\n/g, '\n').split('\n').map(line => ({
      type: kind === 'add' ? 'added' : 'deleted', content: line,
    })));
    expect(file.diff.additions).toBe(kind === 'add' ? 7 : 0);
    expect(file.diff.deletions).toBe(kind === 'delete' ? 7 : 0);
    expect(file.content).toBe(content);
  });

  it('preserves lone carriage returns when replaying apply_patch alongside native file changes', () => {
    const [native] = readPatchFiles({ changes: [{ path: 'lines.txt', kind: 'add', diff: 'first\rsecond\r\nthird\r\n' }] });
    const [history] = readPatchFiles({ patch:
      '*** Begin Patch\r\n*** Add File: lines.txt\r\n+first\rsecond\r\n+third\r\n*** End Patch\r\n' });
    expect(history.diff).toEqual(native.diff);
    const [updated] = readPatchFiles({ changes: [{ path: 'lines.txt', kind: 'update', diff: '@@ -1 +1 @@\r\n-before\rvalue\r\n+after\rvalue\r\n' }] });
    expect(updated.diff.additions).toBe(1);
    expect(updated.diff.deletions).toBe(1);
    expect(updated.diff.lines).toContainEqual({ type: 'added', content: 'after\rvalue' });
  });

  it.each(['', '\n', 'text', 'text\n', 'text\n\n'])('counts native content lines without inventing an EOF line for %j', (content) => {
    const [file] = readPatchFiles({ changes: [{ path: 'a.txt', type: 'add', diff: content }] });
    const count = content === '' ? 0 : content.split('\n').length - Number(content.endsWith('\n'));
    expect(file.diff.additions).toBe(count);
    expect(file.diff.deletions).toBe(0);
    expect(file.content).toBe(content);
  });

  it('uses explicit recorded content before a display diff and keeps unified_diff compatibility', () => {
    const [added, deleted] = readPatchFiles({ changes: [
      { path: 'a.txt', kind: 'add', content: '+literal\n', diff: '++literal' },
      { path: 'b.txt', type: 'delete', unified_diff: '--- a/b.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-- list item' },
    ] });
    expect(added.diff.lines).toEqual([{ type: 'added', content: '+literal' }]);
    expect(deleted.diff.deletions).toBe(1);
    expect(deleted.diff.lines.at(-1)).toEqual({ type: 'deleted', content: '- list item' });
  });

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
