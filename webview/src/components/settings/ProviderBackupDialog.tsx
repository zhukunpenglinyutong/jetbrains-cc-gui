import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { sendBridgeEvent, sendToJava } from '../../utils/bridge';
import styles from './ProviderBackupDialog.module.less';

export type ProviderBackupMode = 'import' | 'export';
type Action = ProviderBackupMode | 'select';
/** 'dialog': a native file dialog may be open, so no timeout applies yet. */
type Phase = 'idle' | 'dialog' | 'processing';
type ToastType = 'info' | 'success' | 'warning' | 'error';
interface Selection { selection: string; fileName: string; encrypted: boolean }
interface Result extends Partial<Selection> {
  requestId: string;
  engine: string;
  status: string;
  imported?: number;
  exported?: number;
  skipped?: number;
  skippedProviders?: unknown;
  providerIndex?: number;
  field?: string;
}
interface BackupError { code: string; providerIndex?: number; field?: string }
interface Props {
  engine: 'claude' | 'codex';
  mode: ProviderBackupMode;
  onClose: () => void;
  addToast: (message: string, type: ToastType) => void;
}
interface Pending { id: string; action: Action; timeout: ReturnType<typeof setTimeout> | null }

const KEY = 'settings.provider.backup.';
const ERROR_CODES = new Set([
  'invalidFile', 'wrongEngine', 'tooLarge', 'empty', 'passwordRequired', 'wrongPassword',
  'failed', 'busy', 'selectFile', 'passwordShort',
]);
const ERROR_FIELDS = new Map([
  ['name', 'name'], ['remark', 'remark'], ['websiteUrl', 'websiteUrl'], ['category', 'category'],
  ['settingsConfig', 'settingsConfig'], ['configToml', 'config.toml'], ['authJson', 'auth.json'],
  ['customModels', 'customModels'], ['messageEnvVars', 'messageEnvVars'], ['mcpEnvVars', 'mcpEnvVars'],
]);
const PROCESSING_TIMEOUT_MS = 120_000;
let nextRequestId = 0;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Only numeric saved-provider positions from the bridge are rendered. */
function skippedPositions(result: Result, skipped: number): string {
  const positions = Array.isArray(result.skippedProviders) ? result.skippedProviders.filter(count) : [];
  const listed = positions.map(position => `#${position}`);
  return [...listed, ...(skipped > positions.length ? ['…'] : [])].join(', ');
}

function successToast(t: TFunction, action: Action, result: Result): [string, ToastType] {
  if (action === 'import') {
    return [t(KEY + 'importSuccess', { imported: count(result.imported), skipped: count(result.skipped) }), 'success'];
  }
  const skipped = count(result.skipped);
  if (skipped === 0) return [t(KEY + 'exportSuccess'), 'success'];
  return [t(KEY + 'exportPartial', {
    exported: count(result.exported), skipped, positions: skippedPositions(result, skipped),
  }), 'warning'];
}

export default function ProviderBackupDialog({ engine, mode, onClose, addToast }: Props) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [allowPlaintext, setAllowPlaintext] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const busy = phase !== 'idle';
  const [error, setError] = useState<BackupError | null>(null);
  const pending = useRef<Pending | null>(null);
  const title = t(KEY + (mode === 'export' ? 'exportTitle' : 'importTitle'), {
    engine: engine === 'claude' ? 'Claude Code' : 'Codex',
  });

  const expire = useCallback((id: string) => {
    if (pending.current?.id !== id) return;
    pending.current = null;
    setPhase('idle');
    setError({ code: 'timeout' });
  }, []);

  useEffect(() => {
    const receive = (event: Event) => {
      const result = (event as CustomEvent<Result>).detail;
      const request = pending.current;
      if (!request || result?.requestId !== request.id || result.engine !== engine) return;
      if (result.status === 'processing') {
        // The native dialog has closed; only the remaining work is bounded by the timeout.
        if (request.timeout === null) {
          pending.current = { ...request, timeout: setTimeout(() => expire(request.id), PROCESSING_TIMEOUT_MS) };
          setPhase('processing');
        }
        return;
      }
      if (request.timeout !== null) clearTimeout(request.timeout);
      pending.current = null;
      setPhase('idle');
      if (result.status === 'cancelled') return;
      if (result.status !== 'success') {
        const exporting = request.action === 'export';
        const code = ERROR_CODES.has(result.status) ? result.status : 'failed';
        const providerIndex = exporting && typeof result.providerIndex === 'number'
          && Number.isInteger(result.providerIndex) && result.providerIndex > 0 && result.providerIndex <= 2000
          ? result.providerIndex : undefined;
        setError({
          code: exporting && code === 'invalidFile' ? 'exportInvalidConfig' : code,
          providerIndex,
          field: exporting && typeof result.field === 'string' ? ERROR_FIELDS.get(result.field) : undefined,
        });
        return;
      }
      if (request.action === 'select') {
        if (typeof result.selection !== 'string' || typeof result.fileName !== 'string'
          || typeof result.encrypted !== 'boolean') {
          setError({ code: 'invalidFile' });
          return;
        }
        setSelection(result as Selection);
        setPassword('');
      } else {
        if (request.action === 'import') {
          sendToJava(engine === 'claude' ? 'get_providers' : 'get_codex_providers');
        }
        addToast(...successToast(t, request.action, result));
        onClose();
      }
    };
    window.addEventListener('provider-backup-result', receive);
    return () => window.removeEventListener('provider-backup-result', receive);
  }, [engine, addToast, onClose, t, expire]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('button, input')?.focus();
    return () => {
      if (pending.current?.timeout) clearTimeout(pending.current.timeout);
      pending.current = null;
      previousFocus?.focus();
    };
  }, []);

  function request(action: Action) {
    if (pending.current) return;
    setError(null);
    const id = `backup-${Date.now()}-${++nextRequestId}`;
    // Select and export open a native dialog first; the user may take any time choosing a file.
    const opensDialog = action !== 'import';
    const timeout = opensDialog ? null : setTimeout(() => expire(id), PROCESSING_TIMEOUT_MS);
    pending.current = { id, action, timeout };
    setPhase(opensDialog ? 'dialog' : 'processing');
    const sent = sendBridgeEvent('provider_backup', JSON.stringify({
      requestId: id, engine, action, dialogTitle: title,
      ...(action !== 'select' ? { password, selection: selection?.selection } : {}),
    }));
    if (!sent) {
      if (timeout !== null) clearTimeout(timeout);
      pending.current = null;
      setPhase('idle');
      setError({ code: 'failed' });
    }
  }

  function submit() {
    if (pending.current) return;
    if (mode === 'import') {
      if (!selection) return setError({ code: 'selectFile' });
      if (selection.encrypted && !password) return setError({ code: 'passwordRequired' });
    } else {
      if (password && password.length < 8) return setError({ code: 'passwordShort' });
      if (password && password !== confirmation) return setError({ code: 'passwordMismatch' });
      if (!password && !allowPlaintext) return setError({ code: 'plaintextWarning' });
    }
    request(mode);
  }

  return createPortal(
    <div className={styles.overlay}>
      <form ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-busy={busy} onSubmit={event => { event.preventDefault(); submit(); }}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (phase !== 'processing') onClose();
          }
          if (event.key === 'Tab') {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
            if (!controls?.length) return;
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <h3 id={titleId}>{title}</h3>
        <p>{t(KEY + 'scope')}</p>
        {mode === 'import' && <>
          <button type="button" disabled={busy} onClick={() => request('select')}>{t(KEY + 'selectFile')}</button>
          {selection && <p className={styles.fileName}>{selection.fileName}</p>}
          <p>{t(KEY + 'mergeHint')}</p>
        </>}
        {(mode === 'export' || selection?.encrypted) && <label>
          {t(KEY + (mode === 'export' ? 'passwordOptional' : 'passwordRequired'))}
          <input type="password" autoComplete="off" maxLength={1024} value={password} disabled={busy}
            onChange={event => setPassword(event.target.value)} />
        </label>}
        {mode === 'export' && <>
          {password ? <label>
            {t(KEY + 'confirmPassword')}
            <input type="password" autoComplete="off" maxLength={1024} value={confirmation} disabled={busy}
              onChange={event => setConfirmation(event.target.value)} />
          </label> : <label className={styles.warning}>
            <input type="checkbox" checked={allowPlaintext} disabled={busy}
              onChange={event => setAllowPlaintext(event.target.checked)} />
            {t(KEY + 'plaintextWarning')}
          </label>}
          <p>{t(KEY + 'passwordHint')}</p>
        </>}
        {error && <p role="alert" className={styles.error}>
          {t(KEY + error.code)}
          {error.providerIndex !== undefined ? <> {t(KEY + 'errorProvider', { index: error.providerIndex })}</> : null}
          {error.field ? <> {t(KEY + 'errorField', { field: error.field })}</> : null}
        </p>}
        {phase === 'processing' && <p role="status">{t(KEY + 'working')}</p>}
        <div className={styles.footer}>
          <button type="button" disabled={phase === 'processing'} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" disabled={busy} className={styles.primary}>
            {t(KEY + mode)}
          </button>
        </div>
      </form>
    </div>, document.body,
  );
}
