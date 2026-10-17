import { describe, expect, it } from 'vitest';
import { migrateCodexSettingsSnapshot } from './modelProviderStateHelpers';

describe('migrateCodexSettingsSnapshot', () => {
  it('preserves native plan and explicit full access', () => {
    expect(migrateCodexSettingsSnapshot({
      codexPermissionMode: 'plan',
      codexApprovalPreset: 'full-access',
      codexSandboxSelection: 'danger-full-access',
      codexSandboxSource: 'native',
      codexSettingsMigrationVersion: 4,
    })).toEqual({
      collaborationMode: 'plan',
      approvalPreset: 'full-access',
      sandboxSelection: 'danger-full-access',
      sandboxSource: 'native',
      migrationVersion: 4,
    });
  });

  it('does not infer full access from a legacy bypass value without evidence', () => {
    expect(migrateCodexSettingsSnapshot({ codexPermissionMode: 'bypassPermissions' })).toMatchObject({
      approvalPreset: 'sandboxed-auto',
      sandboxSelection: 'workspace-write',
      sandboxSource: 'default',
    });
  });

  it('maps legacy read-only and auto values once', () => {
    expect(migrateCodexSettingsSnapshot({
      codexPermissionMode: 'readOnly',
    })).toMatchObject({
      approvalPreset: 'request',
      sandboxSelection: 'read-only',
      migrationVersion: 1,
    });
  });
});
