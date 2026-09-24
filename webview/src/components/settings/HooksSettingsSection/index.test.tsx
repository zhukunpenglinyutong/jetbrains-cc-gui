import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HookCatalog, HookItem } from '../../../types/hooks';
import type { UseHookManagementReturn } from '../hooks';
import HooksSettingsSection from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const claudeItem: HookItem = {
  sourceId: 'claude-global',
  provider: 'claude',
  scope: 'GLOBAL',
  event: 'PreToolUse',
  matcher: 'Bash',
  command: 'echo ready',
  enabled: true,
  toggleSupported: false,
  rawLocation: 'C:/Users/test/.claude/settings.json',
  schemaVersion: 1,
  format: 'claude-settings-json',
  revision: '1:1',
  lastModified: 1720000000000,
  validationIssues: [],
  rawPreview: '{"command":"echo ready"}',
  extensions: { customMode: 'safe' },
};

const catalog: HookCatalog = {
  schemaVersion: 1,
  readOnly: false,
  sources: [],
  capabilities: [{
    provider: 'claude',
    format: 'settings-json',
    editSupported: true,
    toggleSupported: false,
    reasonCode: 'CLAUDE_INDIVIDUAL_TOGGLE_UNSUPPORTED',
    versionStatus: 'UNVERIFIED',
  }],
  items: [claudeItem],
};

function createManagement(overrides: Partial<UseHookManagementReturn> = {}): UseHookManagementReturn {
  return {
    catalog,
    hooksLoading: false,
    loadHooks: vi.fn(),
    updateHooks: vi.fn(),
    editor: null,
    sourceLoading: false,
    mutationLoading: false,
    loadHookSource: vi.fn(),
    reloadHookSource: vi.fn(),
    saveHookSource: vi.fn(),
    restoreHookSource: vi.fn(),
    canRestore: false,
    lastBackupPath: null,
    sourceError: null,
    mutationError: null,
    toggleLoadingId: null,
    toggleError: null,
    toggleHook: vi.fn(),
    updateHookSource: vi.fn(),
    updateHookMutationResult: vi.fn(),
    ...overrides,
  };
}

describe('HooksSettingsSection', () => {
  it('renders compact provider groups and filters by provider and search query', async () => {
    const codexItem: HookItem = {
      ...claudeItem,
      sourceId: 'codex-global',
      provider: 'codex',
      event: 'pre_tool_use',
      command: 'python guard.py',
      format: 'config-toml',
    };
    const management = createManagement({
      catalog: { ...catalog, items: [claudeItem, codexItem] },
    });

    render(<HooksSettingsSection management={management} />);

    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Codex 1$/ }));
    expect(screen.getByText('pre_tool_use')).toBeTruthy();
    expect(screen.queryByText('PreToolUse')).toBeNull();

    fireEvent.change(screen.getByLabelText('settings.hooks.search'), { target: { value: 'missing hook' } });
    expect(await screen.findByText('settings.hooks.noMatches')).toBeTruthy();
  });

  it('does not render a provider-wide Claude switch', () => {
    render(<HooksSettingsSection management={createManagement()} />);

    expect(screen.queryByText('settings.hooks.sourceControlTitle')).toBeNull();
    expect(screen.queryByLabelText('settings.hooks.sourceControl')).toBeNull();
  });

  it('opens the source editor and refreshes the catalog', () => {
    const management = createManagement();
    render(<HooksSettingsSection management={management} />);

    expect(screen.getByText('PreToolUse')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.hooks.editSource: PreToolUse' }));
    expect(management.loadHookSource).toHaveBeenCalledWith(claudeItem);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByTitle('settings.hooks.refresh'));
    expect(management.loadHooks).toHaveBeenCalledTimes(1);
  });

  it('renders and invokes a provider-native hook toggle', () => {
    const nativeItem: HookItem = {
      ...claudeItem,
      sourceId: 'codex-global',
      provider: 'codex',
      event: 'pre_tool_use',
      format: 'config-toml',
      toggleSupported: true,
      managedToggleSupported: false,
      toggleMode: 'native',
    };
    const toggleHook = vi.fn();
    const management = createManagement({
      catalog: {
        ...catalog,
        items: [nativeItem],
        capabilities: [{
          provider: 'codex',
          format: 'config-toml',
          editSupported: true,
          toggleSupported: true,
          managedToggleSupported: false,
          toggleMode: 'native',
          reasonCode: 'CODEX_CONFIG_HOOKS_SUPPORTED',
          versionStatus: 'VERIFIED',
        }],
      },
      toggleHook,
    });

    render(<HooksSettingsSection management={management} />);
    const toggleButton = screen.getByRole('button', { name: 'settings.hooks.disable' });
    expect(toggleButton.querySelector('.codicon-check')).toBeTruthy();
    fireEvent.click(toggleButton);

    expect(toggleHook).toHaveBeenCalledWith(nativeItem, false);
    expect(management.loadHookSource).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps save disabled when review shows no source changes', () => {
    const management = createManagement({
      editor: {
        item: claudeItem,
        content: 'echo ready',
        revision: claudeItem.revision,
        backupDirectory: 'C:/Users/test/.claude/.ccgui-hooks-backups',
        lastModified: claudeItem.lastModified ?? null,
      },
    });

    render(<HooksSettingsSection management={management} />);
    fireEvent.click(screen.getByTitle('settings.hooks.editSource'));
    fireEvent.click(screen.getByText('settings.hooks.reviewChanges'));

    expect(screen.getByText('settings.hooks.noChanges')).toBeTruthy();
    expect((screen.getByRole('button', { name: /settings.hooks.save/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(management.saveHookSource).not.toHaveBeenCalled();
  });

  it('keeps the local draft while synchronizing a conflict to the latest revision', () => {
    const baseManagement = createManagement({
      editor: {
        item: claudeItem,
        content: 'echo ready',
        revision: '1:1',
        backupDirectory: 'C:/Users/test/.claude/.ccgui-hooks-backups',
        lastModified: claudeItem.lastModified ?? null,
      },
      mutationError: 'HOOK_REVISION_CONFLICT',
    });
    const { rerender } = render(<HooksSettingsSection management={baseManagement} />);

    fireEvent.click(screen.getByTitle('settings.hooks.editSource'));
    fireEvent.change(screen.getByLabelText('settings.hooks.sourceEditor'), { target: { value: 'echo local draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.hooks.keepDraft' }));
    expect(baseManagement.reloadHookSource).toHaveBeenCalledTimes(1);

    rerender(<HooksSettingsSection management={{
      ...baseManagement,
      editor: { ...baseManagement.editor!, content: 'echo external change', revision: '2:2' },
      mutationError: null,
    }} />);

    expect((screen.getByLabelText('settings.hooks.sourceEditor') as HTMLTextAreaElement).value).toBe('echo local draft');
    expect(screen.getByText('echo external change')).toBeTruthy();
    expect(screen.getAllByText('echo local draft')).toHaveLength(2);
  });

  it('replaces the local draft when reloading the external version after a conflict', () => {
    const baseManagement = createManagement({
      editor: {
        item: claudeItem,
        content: 'echo ready',
        revision: '1:1',
        backupDirectory: 'C:/Users/test/.claude/.ccgui-hooks-backups',
        lastModified: claudeItem.lastModified ?? null,
      },
      mutationError: 'HOOK_REVISION_CONFLICT',
    });
    const { rerender } = render(<HooksSettingsSection management={baseManagement} />);

    fireEvent.click(screen.getByTitle('settings.hooks.editSource'));
    fireEvent.change(screen.getByLabelText('settings.hooks.sourceEditor'), { target: { value: 'echo local draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'settings.hooks.reloadExternal' }));
    expect(baseManagement.reloadHookSource).toHaveBeenCalledTimes(1);

    rerender(<HooksSettingsSection management={{
      ...baseManagement,
      editor: { ...baseManagement.editor!, content: 'echo external change', revision: '2:2' },
      mutationError: null,
    }} />);

    expect((screen.getByLabelText('settings.hooks.sourceEditor') as HTMLTextAreaElement).value)
      .toBe('echo external change');
  });

  it('keeps technical metadata collapsed until requested and refreshes selected item data', () => {
    const management = createManagement({
      editor: {
        item: claudeItem,
        content: '{\n  "hooks": {}\n}\n',
        revision: '1:1',
        backupDirectory: 'C:/Users/test/.claude/.ccgui-hooks-backups',
        lastModified: claudeItem.lastModified ?? null,
      },
      canRestore: true,
      lastBackupPath: 'C:/Users/test/.claude/.ccgui-hooks-backups/settings.backup.json',
    });
    const { rerender } = render(<HooksSettingsSection management={management} />);

    fireEvent.click(screen.getByTitle('settings.hooks.editSource'));
    const technicalDetails = screen.getByText('settings.hooks.technicalInfo').closest('details')!;
    expect(technicalDetails.open).toBe(false);
    fireEvent.click(screen.getByText('settings.hooks.technicalInfo'));
    expect(technicalDetails.open).toBe(true);
    expect(screen.getByText('settings.hooks.providerFields')).toBeTruthy();
    expect(screen.getByText(/"customMode": "safe"/)).toBeTruthy();
    expect(screen.getByText('settings.hooks.backupDirectory')).toBeTruthy();
    expect(screen.getByText('settings.hooks.latestBackup')).toBeTruthy();
    expect(screen.queryByLabelText('settings.hooks.sourceControl')).toBeNull();

    const refreshedCatalog: HookCatalog = {
      ...catalog,
      items: [{ ...claudeItem, sourceId: 'claude-global-updated', command: 'echo updated', extensions: { customMode: 'updated' } }],
    };
    rerender(<HooksSettingsSection management={{ ...management, catalog: refreshedCatalog }} />);

    expect(screen.getAllByText('echo updated')).toHaveLength(2);
    expect(screen.getByText(/"customMode": "updated"/)).toBeTruthy();
  });

  it('asks before closing an editor with unsaved changes', () => {
    const management = createManagement({
      editor: {
        item: claudeItem,
        content: 'echo ready',
        revision: '1:1',
        backupDirectory: 'C:/Users/test/.claude/.ccgui-hooks-backups',
        lastModified: claudeItem.lastModified ?? null,
      },
    });
    render(<HooksSettingsSection management={management} />);

    fireEvent.click(screen.getByTitle('settings.hooks.editSource'));
    fireEvent.change(screen.getByLabelText('settings.hooks.sourceEditor'), { target: { value: 'echo changed' } });
    fireEvent.click(screen.getByTitle('common.close'));
    expect(screen.getByText('settings.hooks.discardChangesTitle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.hooks.discardDraft' }));
    expect(screen.queryByLabelText('settings.hooks.sourceEditor')).toBeNull();
  });
});
