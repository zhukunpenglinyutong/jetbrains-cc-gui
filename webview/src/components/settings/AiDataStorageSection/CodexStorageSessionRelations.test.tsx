import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CodexStorageSession } from './codexStorageBridge';
import CodexStorageSessionRelations from './CodexStorageSessionRelations';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: { count: number }) =>
  options ? `${key}:${options.count}` : key }) }));
const row: CodexStorageSession = { sessionId: 'child', title: 'Child session', cwd: '/project', storageMode: 'file',
  fileSize: 10, firstTimestamp: 1, lastTimestamp: 2, archived: false, running: false, readable: true };

describe('Codex storage session relationships', () => {
  it('keeps ordinary sessions uncluttered and marks parents with direct child counts', () => {
    const view = render(<CodexStorageSessionRelations session={row} />);
    expect(view.container.textContent).toBe('');
    view.rerender(<CodexStorageSessionRelations session={{ ...row, childCount: 2 }} />);
    expect(screen.getByText('settings.codexStorage.relations.mainSession')).toBeTruthy();
    expect(screen.getByText('settings.codexStorage.relations.childCount:2')).toBeTruthy();
  });

  it('shows a parent outside the current page using its title and ID as plain text', () => {
    const title = '<img src=x onerror=alert(1)> Renamed main session';
    const view = render(<CodexStorageSessionRelations session={{ ...row, parentId: '12345678-parent-id',
      parentTitle: title, parentAvailable: true }} />);
    expect(screen.getByText('settings.codexStorage.relations.subagent')).toBeTruthy();
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText('12345678')).toBeTruthy();
    expect(view.container.querySelector('[title]')?.getAttribute('title')).toContain('12345678-parent-id');
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.queryByText('settings.codexStorage.relations.parentMissing')).toBeNull();
  });

  it('distinguishes a nested subagent from the main session even when it has children', () => {
    render(<CodexStorageSessionRelations session={{ ...row, subagent: true, parentId: 'nested-parent',
      parentTitle: 'Parent agent', parentIsSubagent: true, childCount: 1 }} />);
    expect(screen.getByText('settings.codexStorage.relations.subagent')).toBeTruthy();
    expect(screen.getByText('settings.codexStorage.relations.parentSession', { exact: false })).toBeTruthy();
    expect(screen.getByText('settings.codexStorage.relations.childCount:1')).toBeTruthy();
    expect(screen.queryByText('settings.codexStorage.relations.mainSession')).toBeNull();
  });

  it('retains a missing parent ID and does not present it as a resolved title', () => {
    render(<CodexStorageSessionRelations session={{ ...row, subagent: true, parentId: 'missing-parent',
      parentTitle: 'missing-parent', parentAvailable: false }} />);
    expect(screen.getByText('missing-')).toBeTruthy();
    expect(screen.getByText('settings.codexStorage.relations.parentMissing')).toBeTruthy();
    expect(screen.queryByText('missing-parent')).toBeNull();
  });

  it('labels a native subagent with unavailable parent metadata without guessing a relationship', () => {
    render(<CodexStorageSessionRelations session={{ ...row, subagent: true }} />);
    expect(screen.getByText('settings.codexStorage.relations.subagent')).toBeTruthy();
    expect(screen.getByText('settings.codexStorage.relations.parentUnknown')).toBeTruthy();
  });
});
