import { collectPatchLedger } from './patchLedger';
import { readPatchFiles } from './codexPatch';
import { buildSessionFileLedger } from './sessionFileLedger';

const owner = { sourceId: 'main', toolUseId: 'patch', agentId: 'main' };
describe('reversible patch ledger', () => {
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
    const [added] = readPatchFiles({ changes: [{ path: '/blank.ts', kind: 'add', diff: '+' }] });
    expect(buildSessionFileLedger(collectPatchLedger(added, owner))[0].additions).toBe(1);
    const [update] = readPatchFiles({ changes: [{ path: '/blank.ts', kind: 'update', diff: '@@ -0,0 +1 @@\n+' }] });
    expect(buildSessionFileLedger(collectPatchLedger(update, owner))[0]).toMatchObject({ status: 'M', additions: 1 });
  });
});
