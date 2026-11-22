import { collectPatchLedger } from './patchLedger';
import { readPatchFiles } from './codexPatch';
import { buildSessionFileLedger } from './sessionFileLedger';

const owner = { sourceId: 'main', toolUseId: 'patch', agentId: 'main' };
describe('reversible patch ledger', () => {
  it.each(['add', 'delete'] as const)('keeps the exact native %s contents for statistics and undo', (kind) => {
    const content = '# Plan\n\n- item\n+literal\n';
    const [file] = readPatchFiles({ changes: [{ path: '/plan.md', kind: { type: kind }, diff: content }] });
    const ops = collectPatchLedger(file, owner);
    expect(ops[0]).toMatchObject({ oldString: kind === 'delete' ? content : '', newString: kind === 'add' ? content : '' });
    expect(buildSessionFileLedger(ops)[0]).toMatchObject({
      status: kind === 'add' ? 'A' : 'D', additions: kind === 'add' ? 4 : 0, deletions: kind === 'delete' ? 4 : 0,
    });
  });

  it.each(['add', 'delete'] as const)('keeps native %s card and ledger counts aligned with literal carriage returns', (kind) => {
    const content = 'first\rsecond\r\nthird\r\n';
    const [file] = readPatchFiles({ changes: [{ path: '/lines.txt', kind, diff: content }] });
    const stats = { additions: kind === 'add' ? 2 : 0, deletions: kind === 'delete' ? 2 : 0 };
    expect(file.diff).toEqual({ ...stats, lines: [
      { type: kind === 'add' ? 'added' : 'deleted', content: 'first\rsecond' },
      { type: kind === 'add' ? 'added' : 'deleted', content: 'third' },
    ] });
    const ops = collectPatchLedger(file, owner);
    expect(ops[0]).toMatchObject({ oldString: kind === 'delete' ? content : '', newString: kind === 'add' ? content : '' });
    expect(buildSessionFileLedger(ops)[0]).toMatchObject(stats);
  });

  it.each(['literal', 'literal\n', '\n', ''])('retains native EOF semantics for %j', (content) => {
    const [file] = readPatchFiles({ changes: [{ path: '/gone.ts', kind: 'delete', diff: content }] });
    expect(collectPatchLedger(file, owner)[0]).toMatchObject({ oldString: content, oldStringKnown: true });
  });

  it('retains complete recorded content, including absent final newlines', () => {
    const [file] = readPatchFiles({ changes: [{ path: '/gone.ts', type: 'delete', content: 'literal', diff: '-literal' }] });
    expect(collectPatchLedger(file, owner)[0]).toMatchObject({ oldString: 'literal', oldStringKnown: true, fileChangeKind: 'delete' });
    const [unknown] = readPatchFiles({ patch: '*** Begin Patch\n*** Delete File: /gone.ts\n*** End Patch' });
    expect(collectPatchLedger(unknown, owner)[0].oldStringKnown).toBe(false);
  });

  it('keeps every hunk, EOF marker and only one rename operation', () => {
    const [file] = readPatchFiles({ changes: [{ path: '/old.ts', kind: { type: 'update', movePath: '/new.ts' },
      diff: '--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -5 +5 @@\n-c\n\\ No newline at end of file\n+d\n\\ No newline at end of file' }] });
    const ops = collectPatchLedger(file, owner);
    expect(ops).toHaveLength(2);
    expect(ops.map(op => op.moveFrom)).toEqual(['/old.ts', undefined]);
    expect(ops[1].patch).toContain('\\ No newline at end of file');
    expect(ops[1].lineStart).toBe(5);
    const [move] = readPatchFiles({ changes: [{ path: '/old.ts', kind: { type: 'update', movePath: '/new.ts' }, diff: '' }] });
    expect(buildSessionFileLedger(collectPatchLedger(move, owner))[0]).toMatchObject({ status: 'R', filePath: '/new.ts' });
  });

  it('counts a blank file line and retains an update that only inserts a blank line', () => {
    const [added] = readPatchFiles({ changes: [{ path: '/blank.ts', kind: 'add', diff: '\n' }] });
    expect(buildSessionFileLedger(collectPatchLedger(added, owner))[0].additions).toBe(1);
    const [update] = readPatchFiles({ changes: [{ path: '/blank.ts', kind: 'update', diff: '@@ -0,0 +1 @@\n+' }] });
    expect(buildSessionFileLedger(collectPatchLedger(update, owner))[0]).toMatchObject({ status: 'M', additions: 1 });
  });
});
