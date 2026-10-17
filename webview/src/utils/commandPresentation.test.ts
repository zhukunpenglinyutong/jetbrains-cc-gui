import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { presentCommand } from './commandPresentation';

const t = ((key: string, values?: Record<string, string>) => `${key}: ${values?.path ?? ''} ${values?.query ?? ''}`.trim()) as TFunction;

describe('command descriptions', () => {
  it.each([
    ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg -n \'apply_patch\' src"', "rg -n 'apply_patch' src"],
    ['pwsh -NoProfile -NonInteractive -Command "Get-Content AGENTS.md"', 'Get-Content AGENTS.md'],
    ["/bin/bash -lc 'rg --files src'", 'rg --files src'],
    ['pwsh -Command rg --files', 'rg --files'],
    ['echo "pwsh -Command hello"', 'echo "pwsh -Command hello"'],
    ['pwsh -File script.ps1', 'pwsh -File script.ps1'],
  ])('presents shell wrappers consistently while retaining the original command', (command, displayCommand) => {
    const result = presentCommand({ command }, t);
    expect(result.command).toBe(command);
    expect(result.displayCommand).toBe(displayCommand);
    expect(result.description).toBe(displayCommand);
  });
  it('retains explicit summaries and approval reasons separately', () => {
    expect(presentCommand({ cmd: 'pwd', summary: 'Inspect the active workspace', justification: 'Access protected workspace' }, t))
      .toEqual({ command: 'pwd', displayCommand: 'pwd', description: 'Inspect the active workspace', justification: 'Access protected workspace' });
    expect(presentCommand({ command: 'pwd', description: 'Original description', summary: 'Other', approvalReason: 'Native reason' }, t).description)
      .toBe('Original description');
  });
  it('summarizes known native actions without guessing why unknown commands ran', () => {
    expect(presentCommand({ command: 'cat /file', description: 'cat /file', commandActions: [{ type: 'read', path: '/file' }] }, t).description)
      .toBe('tools.commandRead: /file');
    const bare = presentCommand({ command: 'opaque --flag', commandActions: [{ type: 'unknown' }] }, t);
    expect(bare.description).toBe('opaque --flag');
    expect(bare.justification).toBe('');
  });
  it('presents quoted paths, native actions and shell flags without changing user arguments', () => {
    expect(presentCommand({ command: '  pwsh -Command \'Get-Content "my file.md"\'  ' }, t).description).toBe('Get-Content "my file.md"');
    expect(presentCommand({ cmd: '"/bin/zsh" -c "printf hello"' }, t).displayCommand).toBe('printf hello');
    expect(presentCommand({ command: 'pwsh -EncodedCommand ZWNobw==' }, t).displayCommand).toBe('pwsh -EncodedCommand ZWNobw==');
    expect(presentCommand({ command: 'pwd', commandActions: [null, { type: 'listFiles', name: 'src' },
      { type: 'search', query: 'needle', path: 'src' }] }, t).description).toBe('tools.commandList: src · tools.commandSearch: src needle');
    expect(presentCommand(undefined, t)).toEqual({ command: '', displayCommand: '', description: '', justification: '' });
  });
});
