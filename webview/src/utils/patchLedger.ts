import type { PatchFile } from './codexPatch';
import type { LedgerOp } from './sessionFileLedger';

/** Keep patch hunks reversible without claiming that a hunk is a whole file. */
export function collectPatchLedger(file: PatchFile, owner: Pick<LedgerOp, 'sourceId' | 'toolUseId' | 'agentId'>): LedgerOp[] {
  const common = { ...owner, filePath: file.movePath ?? file.path, fileChangeKind: file.kind,
    ...(file.movePath ? { moveFrom: file.path } : {}) };
  if (file.kind !== 'update') {
    const lines = file.diff.lines.filter(line => line.type === (file.kind === 'add' ? 'added' : 'deleted'));
    const content = file.content ?? (lines.map(line => line.content).join('\n')
      + (lines.length && !file.diffText?.includes('\\ No newline at end of file') ? '\n' : ''));
    return [{ ...common, toolName: file.kind === 'add' ? 'write' : 'edit',
      oldString: file.kind === 'delete' ? content : '', newString: file.kind === 'add' ? content : '',
      ...(file.kind === 'delete' ? { oldStringKnown: file.fullContentKnown !== false } : {}) }];
  }
  const ops: LedgerOp[] = [];
  let header = '@@';
  let body: typeof file.diff.lines = [];
  let rawBody: string[] = [];
  const flush = () => {
    if (!body.length) return;
    const oldString = body.filter(line => line.type !== 'added').map(line => line.content).join('\n');
    const newString = body.filter(line => line.type !== 'deleted').map(line => line.content).join('\n');
    if (oldString === newString && body.filter(line => line.type === 'added').length === body.filter(line => line.type === 'deleted').length) return;
    const location = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
    ops.push({ ...common, toolName: 'edit', oldString, newString,
      ...(location ? { lineStart: Number(location[1]) } : {}),
      patch: [header, ...rawBody].join('\n') });
  };
  let inHunk = !/^--- .+\n\+\+\+ /m.test(file.diffText ?? '');
  for (const line of (file.diffText ?? '').split('\n')) {
    if (line.startsWith('@@')) {
      flush(); body = []; rawBody = []; header = line; inHunk = true;
    } else if (inHunk && /^[+ -]/.test(line)) {
      body.push({ type: line[0] === '+' ? 'added' : line[0] === '-' ? 'deleted' : 'unchanged', content: line.slice(1) });
      rawBody.push(line);
    } else if (inHunk && line === '\\ No newline at end of file') {
      rawBody.push(line);
    }
  }
  flush();
  if (!ops.length && file.movePath) ops.push({ ...common, toolName: 'edit', oldString: '', newString: '' });
  return ops.map((op, index) => index === 0 ? op : { ...op, moveFrom: undefined });
}
