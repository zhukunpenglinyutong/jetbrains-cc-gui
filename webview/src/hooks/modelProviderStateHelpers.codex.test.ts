import { describe, expect, it } from 'vitest';
import {
  deriveCodexAccessScopeFromMode,
  effectiveCodexSandboxFromSettings,
  migrateCodexSettingsSnapshot,
} from './modelProviderStateHelpers';

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

  it('keeps legacy Full Auto on the scope the runtime maps it to', () => {
    // Regression: a snapshot without any sandbox field used to migrate to
    // sandboxed-auto/workspace-write while the selector still showed Full Auto,
    // so writes outside the project were denied with no way to see why.
    expect(migrateCodexSettingsSnapshot({ codexPermissionMode: 'bypassPermissions' })).toMatchObject({
      approvalPreset: 'full-access',
      sandboxSelection: 'danger-full-access',
      sandboxSource: 'default',
    });
  });

  it('respects a narrowed sandbox persisted next to Full Auto', () => {
    expect(migrateCodexSettingsSnapshot({
      codexPermissionMode: 'bypassPermissions',
      codexSandboxSelection: 'workspace-write',
    })).toMatchObject({
      approvalPreset: 'sandboxed-auto',
      sandboxSelection: 'workspace-write',
      sandboxSource: 'migrated',
    });
  });

  it('pairs a persisted full-access preset with a full-access sandbox', () => {
    expect(migrateCodexSettingsSnapshot({
      codexPermissionMode: 'bypassPermissions',
      codexApprovalPreset: 'full-access',
    })).toMatchObject({
      approvalPreset: 'full-access',
      sandboxSelection: 'danger-full-access',
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
    expect(migrateCodexSettingsSnapshot({
      codexPermissionMode: 'auto',
    })).toMatchObject({
      approvalPreset: 'auto',
      sandboxSelection: 'workspace-write',
    });
  });
});

describe('deriveCodexAccessScopeFromMode', () => {
  it('maps Full Auto to unrestricted access so the scope matches the label', () => {
    expect(deriveCodexAccessScopeFromMode('bypassPermissions')).toEqual({
      approvalPreset: 'full-access',
      sandboxSelection: 'danger-full-access',
    });
    expect(deriveCodexAccessScopeFromMode('yolo')).toEqual({
      approvalPreset: 'full-access',
      sandboxSelection: 'danger-full-access',
    });
  });

  it('keeps auto review inside the project sandbox', () => {
    expect(deriveCodexAccessScopeFromMode('auto')).toEqual({
      approvalPreset: 'auto',
      sandboxSelection: 'workspace-write',
    });
  });

  it('leaves modes that do not own an access scope alone', () => {
    expect(deriveCodexAccessScopeFromMode('default')).toBeNull();
    expect(deriveCodexAccessScopeFromMode('plan')).toBeNull();
    expect(deriveCodexAccessScopeFromMode('acceptEdits')).toBeNull();
    expect(deriveCodexAccessScopeFromMode(undefined)).toBeNull();
  });
});

describe('effectiveCodexSandboxFromSettings', () => {
  it('reads the confirmed native policy type', () => {
    expect(effectiveCodexSandboxFromSettings({ sandboxPolicy: { type: 'workspaceWrite' } }))
      .toBe('workspace-write');
    expect(effectiveCodexSandboxFromSettings({ sandboxPolicy: { type: 'dangerFullAccess' } }))
      .toBe('danger-full-access');
    expect(effectiveCodexSandboxFromSettings({ sandboxPolicy: 'readOnly' })).toBe('read-only');
  });

  it('reports unknown instead of guessing the requested value', () => {
    expect(effectiveCodexSandboxFromSettings(null)).toBeNull();
    expect(effectiveCodexSandboxFromSettings({})).toBeNull();
    expect(effectiveCodexSandboxFromSettings({ sandboxPolicy: { type: 'something-else' } }))
      .toBeNull();
  });
});
