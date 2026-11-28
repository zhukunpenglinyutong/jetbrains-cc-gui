import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceWebviewRepaint, repaintRemoteWebview } from '../utils/forceWebviewRepaint';
import CodexProviderDialog from './CodexProviderDialog';
import ConfirmDialog from './ConfirmDialog';
import ProviderDialog from './ProviderDialog';
import HookEditorDialog from './settings/HooksSettingsSection/HookEditorDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../utils/forceWebviewRepaint', () => ({
  forceWebviewRepaint: vi.fn(),
  repaintRemoteWebview: vi.fn(),
}));

const noop = () => {};

const popups = {
  'confirm window': (isOpen: boolean) => (
    <ConfirmDialog isOpen={isOpen} title="t" message="m" onConfirm={noop} onCancel={noop} />
  ),
  'provider editor': (isOpen: boolean) => (
    <ProviderDialog isOpen={isOpen} provider={null} onClose={noop} onSave={noop} onDelete={noop} />
  ),
  'Codex provider editor': (isOpen: boolean) => (
    <CodexProviderDialog isOpen={isOpen} provider={null} onClose={noop} onSave={noop} addToast={noop} />
  ),
  'hook editor': (isOpen: boolean) => (isOpen ? (
    <HookEditorDialog
      selected={{ provider: 'claude', scope: 'project', validationIssues: [], extensions: {} } as never}
      activeEditor={null}
      draft=""
      showDiff={false}
      sourceLoading={false}
      mutationLoading={false}
      sourceError={null}
      mutationError={null}
      canRestore={false}
      lastBackupPath={null}
      onDraftChange={noop}
      onToggleDiff={noop}
      onRestore={noop}
      onSave={noop}
      onResolveConflict={noop}
      onDiscardConflict={noop}
      onRequestClose={noop}
    />
  ) : <></>),
};

describe.each(Object.entries(popups))('%s', (_name, popup) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('repaints the panel when it closes, and once more shortly after', () => {
    const view = render(popup(true));
    expect(forceWebviewRepaint).not.toHaveBeenCalled();
    expect(repaintRemoteWebview).not.toHaveBeenCalled();

    view.rerender(popup(false));

    expect(forceWebviewRepaint).toHaveBeenCalledTimes(1);
    expect(repaintRemoteWebview).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(forceWebviewRepaint).toHaveBeenCalledTimes(2);
    expect(repaintRemoteWebview).toHaveBeenCalledTimes(2);
  });

  it('does not repaint while it was never open', () => {
    const view = render(popup(false));
    view.unmount();
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(forceWebviewRepaint).not.toHaveBeenCalled();
    expect(repaintRemoteWebview).not.toHaveBeenCalled();
  });
});
