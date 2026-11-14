import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ClaudeContentBlock, ClaudeMessage, ToolResultBlock } from '../types';
import { useFileChanges } from './useFileChanges';

interface Call {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** The `{ server, arguments }` shape recorded from a real Codex `mcpToolCall`, live and in history. */
const wrapped = (name: string, args: Record<string, unknown>, server = 'jetbrains'): Call =>
  ({ id: name, name, input: { server, arguments: args } });

const blocksOf = (message: ClaudeMessage): ClaudeContentBlock[] =>
  (message.raw as { content?: ClaudeContentBlock[] }).content ?? [];

function ledger(calls: Call[], result: 'ok' | 'error' | 'pending' = 'ok') {
  const messages = [{
    type: 'assistant',
    content: '',
    raw: { role: 'assistant', content: calls.map(call => ({ type: 'tool_use', ...call })) },
  } as ClaudeMessage];
  const findToolResult = (id?: string) => (result === 'pending' ? null : {
    type: 'tool_result', tool_use_id: id, is_error: result === 'error', content: result,
  } as ToolResultBlock);
  return renderHook(() => useFileChanges({ messages, getContentBlocks: blocksOf, findToolResult })).result.current;
}

const PATCH = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-before\n+after\n keep\n*** End Patch';

describe('useFileChanges with MCP file tools', () => {
  describe('replace_text_in_file (IDEA 2025.x)', () => {
    const args = { pathInProject: 'src/a.ts', oldText: 'before', newText: 'after', projectPath: '/proj' };

    it('records the edit under the project path, on the validated undo plan', () => {
      const [file] = ledger([wrapped('replace_text_in_file', args)]);
      expect(file).toMatchObject({ filePath: '/proj/src/a.ts', status: 'M', additions: 1, deletions: 1 });
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'update', oldString: 'before', newString: 'after' });
      expect(file.operations[0].oldStringKnown).toBeUndefined();
    });

    it.each([
      ['a Windows project root', { projectPath: 'C:\\proj', pathInProject: 'src\\a.ts' }, 'C:\\proj\\src\\a.ts'],
      ['forward slashes under a Windows root', { projectPath: 'C:\\proj', pathInProject: 'src/a.ts' }, 'C:\\proj\\src\\a.ts'],
      ['a trailing separator on the root', { projectPath: '/proj/' }, '/proj/src/a.ts'],
      ['a leading dot segment', { pathInProject: './src/a.ts' }, '/proj/src/a.ts'],
      ['an absolute tool path', { pathInProject: '/elsewhere/a.ts' }, '/elsewhere/a.ts'],
    ])('resolves %s', (_label, override, expected) => {
      const [file] = ledger([wrapped('replace_text_in_file', { ...args, ...override })]);
      expect(file.filePath).toBe(expected);
      expect(file.operations[0].oldStringKnown).toBeUndefined();
    });

    it('refuses undo without a project root, since undo resolves relative paths against the session directory', () => {
      const [file] = ledger([wrapped('replace_text_in_file', { ...args, projectPath: undefined })]);
      expect(file.filePath).toBe('src/a.ts');
      expect(file.operations[0].oldStringKnown).toBe(false);
    });

    it('reads the flat input a prefixed MCP tool name carries', () => {
      const [file] = ledger([{ id: 'flat', name: 'mcp__jetbrains__replace_text_in_file', input: args }]);
      expect(file).toMatchObject({ filePath: '/proj/src/a.ts', additions: 1, deletions: 1 });
      expect(file.operations[0].fileChangeKind).toBe('update');
    });

    it.each([undefined, true, false])('never forwards replaceAll=%s, whose reversal would rewrite earlier text', (replaceAll) => {
      const [file] = ledger([wrapped('replace_text_in_file', { ...args, replaceAll })]);
      expect(file.operations[0].replaceAll).toBeUndefined();
    });

    it('refuses undo of a case-insensitive replacement', () => {
      const [file] = ledger([wrapped('replace_text_in_file', { ...args, caseSensitive: false })]);
      expect(file.operations[0].oldStringKnown).toBe(false);
    });

    it('never reports empty old text as an added file, because undo of an add deletes it', () => {
      const [file] = ledger([wrapped('replace_text_in_file', { ...args, oldText: '' })]);
      expect(file.status).toBe('M');
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'update', oldStringKnown: false });
    });
  });

  describe('create_new_file', () => {
    const args = { pathInProject: 'docs/new.md', text: '# Title\nhello\n', projectPath: '/proj' };

    it('records a new file', () => {
      const [file] = ledger([wrapped('create_new_file', args)]);
      expect(file).toMatchObject({ filePath: '/proj/docs/new.md', status: 'A', additions: 2, deletions: 0 });
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'add', oldString: '', newString: args.text });
    });

    it('records a new empty file', () => {
      const [file] = ledger([wrapped('create_new_file', { pathInProject: 'empty.txt', projectPath: '/proj' })]);
      expect(file).toMatchObject({ filePath: '/proj/empty.txt', status: 'A', additions: 0, deletions: 0 });
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'add', newString: '' });
    });

    it('refuses undo without a project root', () => {
      const [file] = ledger([wrapped('create_new_file', { pathInProject: 'new.md', text: 'x\n' })]);
      expect(file.status).toBe('A');
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'add', oldStringKnown: false });
    });

    it('treats overwrite=false as a new file, since the tool refuses an existing path', () => {
      expect(ledger([wrapped('create_new_file', { ...args, overwrite: false })])[0].status).toBe('A');
    });

    it('never reports an overwrite as an added file, because undo of an add deletes it', () => {
      const [file] = ledger([wrapped('create_new_file', { ...args, overwrite: true })]);
      expect(file.status).toBe('M');
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'update', oldStringKnown: false });
    });
  });

  describe('apply_patch (IDEA 2026.2)', () => {
    it.each(['input', 'patch'])('reads the patch from arguments.%s', (field) => {
      const [file] = ledger([wrapped('apply_patch', { [field]: PATCH, projectPath: '/proj' })]);
      expect(file).toMatchObject({ filePath: '/proj/src/a.ts', status: 'M', additions: 1, deletions: 1 });
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'update', oldString: 'before\nkeep', newString: 'after\nkeep' });
    });

    it('keeps a relative path when the call names no project, and refuses its undo', () => {
      const [file] = ledger([wrapped('apply_patch', { input: PATCH })]);
      expect(file.filePath).toBe('src/a.ts');
      expect(file.operations[0].oldStringKnown).toBe(false);
    });

    it('stays reversible for a patch that names absolute paths', () => {
      const [file] = ledger([wrapped('apply_patch', { input: PATCH.replace('src/a.ts', '/proj/src/a.ts') })]);
      expect(file.filePath).toBe('/proj/src/a.ts');
      expect(file.operations[0].oldStringKnown).toBeUndefined();
    });

    it('refuses undo when only the move source is relative, since undo would restore it elsewhere', () => {
      const moved = '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: /proj/new.ts\n@@\n-a\n+b\n*** End Patch';
      const [file] = ledger([wrapped('apply_patch', { input: moved })]);
      expect(file.filePath).toBe('/proj/new.ts');
      expect(file.operations[0]).toMatchObject({ moveFrom: 'src/old.ts', oldStringKnown: false });
    });

    it('does not touch a native patch with a relative path', () => {
      const [file] = ledger([{ id: 'native', name: 'apply_patch', input: { input: PATCH } }]);
      expect(file.filePath).toBe('src/a.ts');
      expect(file.operations[0].oldStringKnown).toBeUndefined();
    });

    it('resolves both ends of a move', () => {
      const moved = '*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-a\n+b\n*** End Patch';
      const [file] = ledger([wrapped('apply_patch', { input: moved, projectPath: '/proj' })]);
      expect(file).toMatchObject({ filePath: '/proj/src/new.ts', status: 'R' });
      expect(file.operations[0].moveFrom).toBe('/proj/src/old.ts');
    });
  });

  describe('other MCP servers, whose semantics the ledger cannot vouch for', () => {
    const edit = { path: '/proj/a.ts', edits: [{ oldText: 'before', newText: 'after' }] };

    it('lists a wrapped edit but refuses its undo', () => {
      const [file] = ledger([wrapped('edit_file', edit, 'filesystem')]);
      expect(file).toMatchObject({ filePath: '/proj/a.ts', status: 'M', additions: 1, deletions: 1 });
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'update', oldStringKnown: false });
    });

    it('never reports an edit with empty old text as an added file', () => {
      const [file] = ledger([wrapped('edit_file', { path: '/proj/a.ts', edits: [{ oldText: '', newText: 'header\n' }] }, 'filesystem')]);
      expect(file.status).toBe('M');
      expect(file.operations[0].oldStringKnown).toBe(false);
    });

    it('ignores a dry run, which changes nothing', () => {
      expect(ledger([wrapped('edit_file', { ...edit, dryRun: true }, 'filesystem')])).toEqual([]);
    });

    it.each([
      ['wrapped', wrapped('write_file', { path: '/proj/a.ts', content: 'after' }, 'filesystem')],
      ['flat', { id: 'flat', name: 'mcp__filesystem__write_file', input: { path: '/proj/a.ts', content: 'after' } }],
      ['namespaced', { id: 'ns', name: 'functions.mcp__filesystem__write_file', input: { path: '/proj/a.ts', content: 'after' } }],
    ])('refuses undo of a %s whole-file write, whose old content is unknown', (_label, call) => {
      const [file] = ledger([call]);
      expect(file.status).toBe('M');
      expect(file.operations[0]).toMatchObject({ fileChangeKind: 'update', oldStringKnown: false });
    });

    it('still records a write that empties the file', () => {
      const [file] = ledger([wrapped('write_file', { path: '/proj/a.ts', content: '' }, 'filesystem')]);
      expect(file).toMatchObject({ filePath: '/proj/a.ts', status: 'M' });
    });
  });

  it.each(['error', 'pending'] as const)('records nothing for a call that is %s', (result) => {
    const calls = [
      wrapped('replace_text_in_file', { pathInProject: 'a.ts', oldText: 'x', newText: 'y' }),
      wrapped('create_new_file', { pathInProject: 'b.ts', text: 'x' }),
      wrapped('apply_patch', { input: PATCH }),
    ];
    expect(ledger(calls, result)).toEqual([]);
  });

  it('leaves non-MCP tools alone even when they carry an arguments field', () => {
    const edit = { id: 'edit', name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y', arguments: { file_path: '/b.ts' } } };
    expect(ledger([edit])[0].filePath).toBe('/a.ts');
  });

  it('keeps a whole-file write outside MCP undoable as before', () => {
    const write = { id: 'write', name: 'Write', input: { file_path: '/a.ts', content: 'x' } };
    const [file] = ledger([write]);
    expect(file.status).toBe('A');
    expect(file.operations[0].oldStringKnown).toBeUndefined();
    expect(file.operations[0].fileChangeKind).toBeUndefined();
  });
});
