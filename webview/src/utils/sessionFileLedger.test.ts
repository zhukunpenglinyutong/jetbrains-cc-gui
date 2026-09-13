import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applySearchReplace,
  reconstructBaselineAndCurrent,
  buildSessionFileLedger,
  diffLineStats,
  ledgerEntriesToSummaries,
  saveLedgerMeta,
  loadLedgerMeta,
  clearLedgerMeta,
  ledgerStorageKey,
  type LedgerOp,
} from './sessionFileLedger';

function op(partial: Partial<LedgerOp> & Pick<LedgerOp, 'filePath' | 'oldString' | 'newString'>): LedgerOp {
  return {
    toolName: 'Edit',
    agentId: 'main',
    ...partial,
  };
}

describe('applySearchReplace', () => {
  it('replaces first occurrence by default', () => {
    expect(applySearchReplace('a x a', 'a', 'b')).toBe('b x a');
  });

  it('replaces all when replaceAll', () => {
    expect(applySearchReplace('a x a', 'a', 'b', true)).toBe('b x b');
  });

  it('returns content when old missing', () => {
    expect(applySearchReplace('hello', 'zzz', 'y')).toBe('hello');
  });

  it('empty old yields new string (write-style)', () => {
    expect(applySearchReplace('ignored', '', 'full')).toBe('full');
  });
});

describe('diffLineStats', () => {
  it('counts pure additions', () => {
    expect(diffLineStats('', 'a\nb')).toEqual({ additions: 2, deletions: 0 });
  });

  it('counts equal-size large replacements as both + and -', () => {
    const oldS = Array.from({ length: 120 }, (_, i) => `old ${i}`).join('\n');
    const newS = Array.from({ length: 120 }, (_, i) => `new ${i}`).join('\n');
    expect(diffLineStats(oldS, newS)).toEqual({ additions: 120, deletions: 120 });
  });
});

describe('reconstructBaselineAndCurrent', () => {
  it('nets sequential edits on the same region', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/a.ts', oldString: 'v1', newString: 'v2' }),
      op({ filePath: '/a.ts', oldString: 'v2', newString: 'v3' }),
    ];
    const r = reconstructBaselineAndCurrent(ops);
    expect(r.fullyApplied).toBe(true);
    expect(r.baseline).toBe('v1');
    expect(r.current).toBe('v3');
  });

  it('write then edit uses write as full content', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/a.ts', toolName: 'Write', oldString: '', newString: 'line1\nline2' }),
      op({ filePath: '/a.ts', oldString: 'line2', newString: 'line2-changed' }),
    ];
    const r = reconstructBaselineAndCurrent(ops);
    expect(r.fullyApplied).toBe(true);
    expect(r.baseline).toBe('');
    expect(r.current).toBe('line1\nline2-changed');
  });

  it('marks non-overlapping MultiEdit snippets as not fully applied', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/m.ts', oldString: 'foo', newString: 'bar' }),
      op({ filePath: '/m.ts', oldString: 'one\ntwo', newString: 'ONE' }),
    ];
    const r = reconstructBaselineAndCurrent(ops);
    expect(r.fullyApplied).toBe(false);
  });
});

describe('buildSessionFileLedger', () => {
  it('uses net stats for sequential edits (not sum of ops)', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/a.ts', oldString: 'hello', newString: 'hello world' }),
      // reverse almost: go back toward original
      op({ filePath: '/a.ts', oldString: 'hello world', newString: 'hello' }),
    ];
    const entries = buildSessionFileLedger(ops);
    expect(entries).toHaveLength(1);
    // Net zero content change
    expect(entries[0].additions).toBe(0);
    expect(entries[0].deletions).toBe(0);
    expect(entries[0].operations).toHaveLength(2);
  });

  it('sums per-op stats when MultiEdit regions do not chain', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/m.ts', oldString: 'foo', newString: 'bar' }),
      op({ filePath: '/m.ts', oldString: 'one\ntwo', newString: 'ONE' }),
    ];
    const entries = buildSessionFileLedger(ops);
    expect(entries).toHaveLength(1);
    // edit1 +1-1, edit2 +1-2 → +2 -3
    expect(entries[0].additions).toBe(2);
    expect(entries[0].deletions).toBe(3);
  });

  it('sets multiAgent when two agent ids touch same file', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/shared.ts', agentId: 'main', oldString: 'a', newString: 'b' }),
      op({ filePath: '/shared.ts', agentId: 'agent-1', oldString: 'b', newString: 'c' }),
    ];
    const entries = buildSessionFileLedger(ops);
    expect(entries[0].multiAgent).toBe(true);
    expect(entries[0].agentIds.sort()).toEqual(['agent-1', 'main']);
  });

  it('does not set multiAgent for single agent multiple edits', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/x.ts', agentId: 'main', oldString: 'a', newString: 'b' }),
      op({ filePath: '/x.ts', agentId: 'main', oldString: 'b', newString: 'c' }),
    ];
    const entries = buildSessionFileLedger(ops);
    expect(entries[0].multiAgent).toBe(false);
    expect(entries[0].agentIds).toEqual(['main']);
  });

  it('keeps separate files independent', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/a.ts', oldString: 'a', newString: 'A' }),
      op({ filePath: '/b.ts', toolName: 'Write', oldString: '', newString: 'new\nfile' }),
    ];
    const entries = buildSessionFileLedger(ops);
    expect(entries.map((e) => e.filePath).sort()).toEqual(['/a.ts', '/b.ts']);
    const write = entries.find((e) => e.filePath === '/b.ts')!;
    expect(write.status).toBe('A');
    expect(write.additions).toBe(2);
    expect(write.deletions).toBe(0);
  });

  it('ledgerEntriesToSummaries maps multiAgent for UI', () => {
    const ops: LedgerOp[] = [
      op({ filePath: '/s.ts', agentId: 'main', oldString: 'x', newString: 'y' }),
      op({ filePath: '/s.ts', agentId: 'sub', oldString: 'y', newString: 'z' }),
    ];
    const summaries = ledgerEntriesToSummaries(buildSessionFileLedger(ops));
    expect(summaries[0].multiAgent).toBe(true);
    expect(summaries[0].agentIds).toContain('main');
    expect(summaries[0].agentIds).toContain('sub');
  });
});

describe('ledger meta persistence', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('saves and loads meta by session id', () => {
    const sessionId = 'sess-1';
    saveLedgerMeta(sessionId, {
      baseMessageIndex: 3,
      multiAgentPaths: ['/a.ts'],
      updatedAt: 123,
    });
    expect(loadLedgerMeta(sessionId)).toEqual({
      baseMessageIndex: 3,
      multiAgentPaths: ['/a.ts'],
      updatedAt: 123,
    });
    expect(ledgerStorageKey(sessionId)).toBe('session-file-ledger-meta-sess-1');
  });

  it('clearLedgerMeta removes entry', () => {
    saveLedgerMeta('s', { baseMessageIndex: 0, multiAgentPaths: [], updatedAt: 1 });
    clearLedgerMeta('s');
    expect(loadLedgerMeta('s')).toBeNull();
  });
});
