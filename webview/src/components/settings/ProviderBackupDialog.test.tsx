import { act, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProviderBackupDialog from './ProviderBackupDialog';
import { sendBridgeEvent, sendToJava } from '../../utils/bridge';
import en from '../../i18n/locales/en.json';
import zh from '../../i18n/locales/zh.json';
import zhTW from '../../i18n/locales/zh-TW.json';
import ja from '../../i18n/locales/ja.json';
import ko from '../../i18n/locales/ko.json';
import fr from '../../i18n/locales/fr.json';
import es from '../../i18n/locales/es.json';
import ru from '../../i18n/locales/ru.json';
import hi from '../../i18n/locales/hi.json';
import ptBR from '../../i18n/locales/pt-BR.json';

vi.mock('../../utils/bridge', () => ({ sendBridgeEvent: vi.fn(), sendToJava: vi.fn() }));
const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en }, zh: { translation: zh } }, interpolation: { escapeValue: false } });

function mount(mode: 'import' | 'export', engine: 'claude' | 'codex' = 'claude') {
  const onClose = vi.fn();
  const addToast = vi.fn();
  const view = render(<I18nextProvider i18n={i18n}>
    <ProviderBackupDialog mode={mode} engine={engine} onClose={onClose} addToast={addToast} />
  </I18nextProvider>);
  return { ...view, onClose, addToast };
}

function lastRequest() {
  return JSON.parse(vi.mocked(sendBridgeEvent).mock.calls.at(-1)![1]!);
}

function respond(status: string, fields: Record<string, unknown> = {}) {
  const request = lastRequest();
  act(() => window.dispatchEvent(new CustomEvent('provider-backup-result', {
    detail: { requestId: request.requestId, engine: request.engine, status, ...fields },
  })));
}

describe('ProviderBackupDialog', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(sendBridgeEvent).mockReturnValue(true);
    await i18n.changeLanguage('en');
  });
  afterEach(() => vi.useRealTimers());

  it('requires explicit acknowledgement for plaintext exports', () => {
    mount('export');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('alert').textContent).toContain('plain text');
    expect(sendBridgeEvent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(lastRequest()).toMatchObject({ engine: 'claude', action: 'export', password: '' });
  });

  it('validates and confirms the password and prevents repeated submits', () => {
    const { onClose, addToast } = mount('export', 'codex');
    fireEvent.change(screen.getByLabelText('Export password (optional)'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('alert').textContent).toContain('8 characters');
    fireEvent.change(screen.getByLabelText('Export password (optional)'), { target: { value: 'correct password' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'different password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getByRole('alert').textContent).toContain('do not match');
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'correct password' } });
    fireEvent.submit(screen.getByRole('dialog'));
    fireEvent.submit(screen.getByRole('dialog'));
    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(lastRequest()).toMatchObject({ engine: 'codex', action: 'export', dialogTitle: 'Export Codex providers' });
    respond('success');
    expect(addToast).toHaveBeenCalledWith('Configuration exported.', 'success');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('prompts for encrypted file password, retains selection after failure, refreshes only the matching engine', () => {
    const { onClose, addToast } = mount('import', 'codex');
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    respond('success', { selection: 'opaque-token', fileName: 'codex.json', encrypted: true });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByRole('alert').textContent).toContain('password');
    fireEvent.change(screen.getByLabelText('Enter the file password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(lastRequest()).toMatchObject({ selection: 'opaque-token', password: 'wrong', action: 'import' });
    respond('wrongPassword');
    expect(screen.getByRole('alert').textContent).toContain('Incorrect password');
    expect(onClose).not.toHaveBeenCalled();
    expect(sendToJava).not.toHaveBeenCalled();
    expect(screen.getByText('codex.json')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Enter the file password'), { target: { value: 'correct' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    respond('success', { imported: 2, skipped: 3 });
    expect(sendToJava).toHaveBeenCalledExactlyOnceWith('get_codex_providers');
    expect(addToast).toHaveBeenCalledWith('Import complete: 2 added, 3 duplicate configurations skipped.', 'success');
  });

  it('does not consume another tab or stale request result', () => {
    mount('import');
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    respond('success', { engine: 'codex', selection: 'other', fileName: 'wrong.json', encrypted: false });
    respond('success', { requestId: 'stale', selection: 'other', fileName: 'stale.json', encrypted: false });
    expect(screen.queryByText('wrong.json')).toBeNull();
    expect(screen.queryByText('stale.json')).toBeNull();
    respond('success', { selection: 'current', fileName: 'correct.json', encrypted: false });
    expect(screen.getByText('correct.json')).toBeTruthy();
  });

  it('handles cancellation, bridge failure, timeout and listener cleanup', () => {
    vi.useFakeTimers();
    const { onClose, unmount } = mount('import');
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    respond('cancelled');
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(sendBridgeEvent).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    expect(screen.getByRole('alert').textContent).toContain('Operation failed');
    vi.mocked(sendBridgeEvent).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.queryByRole('alert')).toBeNull();
    respond('processing');
    act(() => vi.advanceTimersByTime(119_999));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('alert').textContent).toContain('Timed out');
    unmount();
    respond('success');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not time out while the native file dialog is open and keeps Cancel available until processing', () => {
    vi.useFakeTimers();
    const { onClose, addToast } = mount('export');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
    respond('processing');
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('Working');
    respond('processing');
    respond('success', { exported: 3, skipped: 0, skippedProviders: [] });
    expect(addToast).toHaveBeenCalledExactlyOnceWith('Configuration exported.', 'success');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets Cancel and Escape close the dialog before processing starts, but not during processing', () => {
    for (const close of [
      () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })),
      () => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }),
    ]) {
      const { onClose, unmount } = mount('import');
      fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
      respond('processing');
      close();
      expect(onClose).not.toHaveBeenCalled();
      respond('cancelled');
      fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
      close();
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('clears the processing timeout when the dialog unmounts', () => {
    vi.useFakeTimers();
    const { unmount } = mount('import');
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    expect(vi.getTimerCount()).toBe(0);
    respond('processing');
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts the import timeout immediately because import opens no native dialog', () => {
    vi.useFakeTimers();
    mount('import');
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    respond('success', { selection: 'token', fileName: 'backup.json', encrypted: false });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByRole('alert').textContent).toContain('Timed out');
  });

  it('warns with safe positions when export skipped invalid saved providers', () => {
    const { onClose, addToast } = mount('export', 'codex');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    respond('processing');
    respond('success', { exported: 2, skipped: 25, skippedProviders: [2, 'secret', -1, 1.5, 5, 9] });
    expect(addToast).toHaveBeenCalledExactlyOnceWith(
      'Providers exported: 2. Skipped because they failed validation: 25 (#2, #5, #9, …; numbering excludes local settings and CLI login entries).',
      'warning',
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('uses configured plugin language for native dialog titles and errors', async () => {
    await i18n.changeLanguage('zh');
    mount('import');
    fireEvent.click(screen.getByRole('button', { name: '选择配置文件' }));
    expect(lastRequest().dialogTitle).toBe('导入 Claude Code 供应商');
    respond('wrongEngine');
    expect(screen.getByRole('alert').textContent).toContain('当前页签不一致');
  });

  it('shows export-specific validation errors with safe location details and permits retry', async () => {
    await i18n.changeLanguage('zh');
    const { onClose } = mount('export', 'codex');
    fireEvent.change(screen.getByLabelText('导出密码（可选）'), { target: { value: 'test-password' } });
    fireEvent.change(screen.getByLabelText('再次输入密码'), { target: { value: 'test-password' } });
    fireEvent.submit(screen.getByRole('dialog'));
    respond('invalidFile', { providerIndex: 2, field: 'authJson', message: 'secret-parser-message', providerName: 'secret-name' });
    const message = screen.getByRole('alert').textContent;
    expect(message).toContain('导出失败');
    expect(message).toContain('第 2 条');
    expect(message).toContain('auth.json');
    expect(message).not.toContain('未导入');
    expect(message).not.toContain('secret');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole('dialog'));
    expect(screen.queryByRole('alert')).toBeNull();
    respond('success');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render unrecognized field names or invalid provider positions from the bridge', () => {
    mount('export', 'codex');
    fireEvent.click(screen.getByRole('checkbox'));
    for (const providerIndex of ['secret-index', 0, -1, 1.5, 2001]) {
      fireEvent.submit(screen.getByRole('dialog'));
      respond('invalidFile', { providerIndex, field: 'secret-field' });
      expect(screen.getByRole('alert').textContent).toContain('Export failed');
      expect(screen.getByRole('alert').textContent).not.toContain('secret');
      expect(screen.getByRole('alert').textContent).not.toContain('Field:');
      expect(screen.getByRole('alert').textContent).not.toContain('Check saved provider');
    }
  });

  it('keeps import validation errors separate from export errors', () => {
    mount('import', 'codex');
    fireEvent.click(screen.getByRole('button', { name: 'Select backup file' }));
    respond('invalidFile', { providerIndex: 2, field: 'authJson' });
    expect(screen.getByRole('alert').textContent).toContain('Nothing was imported');
    expect(screen.getByRole('alert').textContent).not.toContain('Export failed');
    expect(screen.getByRole('alert').textContent).not.toContain('Check saved provider');
  });

  it('has complete backup translations in all supported languages', () => {
    const expected = Object.keys(en.settings.provider.backup).sort();
    for (const locale of [zh, zhTW, ja, ko, fr, es, ru, hi, ptBR]) {
      expect(Object.keys(locale.settings.provider.backup).sort()).toEqual(expected);
      for (const value of Object.values(locale.settings.provider.backup)) expect(value.length).toBeGreaterThan(0);
    }
  });
});
