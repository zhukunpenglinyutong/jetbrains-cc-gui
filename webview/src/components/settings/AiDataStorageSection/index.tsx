import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../ConfirmDialog';
import {
  aiDataStorageBridge,
  type AiDataDirectoryOperation,
  type AiDataDirectoryStatus,
} from './aiDataStorageBridge';
import styles from './style.module.less';
import CodexStoragePanel from './CodexStoragePanel';

interface AiDataStorageSectionProps {
  addToast: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
}

type Confirmation =
  | { operation: 'migrate'; targetRoot: string }
  | { operation: 'cleanup' }
  | null;

interface PendingOperation {
  operation: Exclude<AiDataDirectoryOperation['operation'], 'status'>;
  requestId: string;
}

const OPERATION_TIMEOUT_MS = 120000;
let nextRequestId = 0;

function createRequestId(): string {
  nextRequestId += 1;
  return `ai-data-${Date.now()}-${nextRequestId}`;
}

const OPERATION_ERROR_KEYS: Record<string, string> = {
  AI_PROCESSES_ACTIVE: 'settings.storage.errors.aiProcessesActive',
  TARGET_ROOT_MUST_BE_SELECTED: 'settings.storage.errors.targetRootMustBeSelected',
  TARGET_ROOT_REQUIRED: 'settings.storage.errors.targetRootRequired',
  TARGET_ROOT_UNAVAILABLE: 'settings.storage.errors.targetRootUnavailable',
  TARGET_PATH_INVALID: 'settings.storage.errors.targetPathInvalid',
  TARGET_NOT_EMPTY: 'settings.storage.errors.targetNotEmpty',
  TARGET_INSIDE_SOURCE: 'settings.storage.errors.targetInsideSource',
  TARGET_OVERLAPS_HOME: 'settings.storage.errors.targetOverlapsHome',
  AI_DATA_MIGRATION_ACTIVE: 'settings.storage.errors.aiDataMigrationActive',
  AI_DATA_COORDINATION_UNAVAILABLE: 'settings.storage.errors.coordinationUnavailable',
  LEGACY_MIGRATION_STATE_CONFLICT: 'settings.storage.errors.legacyStateConflict',
  PLATFORM_NOT_SUPPORTED: 'settings.storage.errors.platformNotSupported',
  WSL_NOT_SUPPORTED: 'settings.storage.errors.wslNotSupported',
  MIGRATION_CANCELLED_FOR_AI_START: 'settings.storage.errors.migrationCancelledForAiStart',
  MIGRATION_ROLLBACK_FAILED: 'settings.storage.errors.migrationRollbackFailed',
  BACKUP_CLEANUP_PARTIAL: 'settings.storage.errors.backupCleanupPartial',
  BACKUP_METADATA_INVALID: 'settings.storage.errors.backupMetadataInvalid',
  BACKUP_PATH_INVALID: 'settings.storage.errors.backupPathInvalid',
  BACKUP_STILL_ACTIVE: 'settings.storage.errors.backupStillActive',
  LINK_CREATION_FAILED: 'settings.storage.errors.linkCreationFailed',
  LINK_VALIDATION_FAILED: 'settings.storage.errors.linkValidationFailed',
  SOURCE_CHANGED_DURING_MIGRATION: 'settings.storage.errors.sourceChangedDuringMigration',
  SOURCE_NOT_DIRECTORY: 'settings.storage.errors.sourceNotDirectory',
};

function operationErrorMessage(
  translate: (key: string, options?: { product: string; pid: number }) => string,
  error?: string,
  details?: AiDataDirectoryOperation['details'],
): string {
  if (error === 'AI_DATA_MIGRATION_ACTIVE' && details) {
    return translate('settings.storage.errors.aiDataMigrationOwned', {
      product: details.ideProduct,
      pid: details.pid,
    });
  }
  return translate(OPERATION_ERROR_KEYS[error?.trim() ?? ''] ?? 'settings.storage.operationFailed');
}

function comparablePath(path: string, platform?: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'windows' ? normalized.toLowerCase() : normalized;
}

export default function AiDataStorageSection({ addToast }: AiDataStorageSectionProps) {
  const { t } = useTranslation();
  const addToastRef = useRef(addToast);
  const translateRef = useRef(t);
  const [status, setStatus] = useState<AiDataDirectoryStatus | null>(null);
  const [targetRoot, setTargetRoot] = useState('');
  const [pending, setPending] = useState<PendingOperation['operation'] | null>(null);
  const pendingOperationRef = useRef<PendingOperation | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const operationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    addToastRef.current = addToast;
    translateRef.current = t;
  }, [addToast, t]);

  useEffect(() => {
    const unsubscribeStatus = aiDataStorageBridge.subscribeStatus((nextStatus) => {
      setStatus(nextStatus);
      setTargetRoot((current) => current || nextStatus.storageRoot || '');
      if (nextStatus.recovered) {
        addToastRef.current(translateRef.current('settings.storage.recovered'), 'warning');
      }
    });
    const unsubscribeRoot = aiDataStorageBridge.subscribeRoot(setTargetRoot);
    const unsubscribeOperation = aiDataStorageBridge.subscribeOperation((operation) => {
      if (operation.operation === 'status') {
        if (operation.status) {
          setStatus(operation.status);
        } else if (!operation.success) {
          setStatus(null);
          if (operation.error === 'AI_PROCESSES_ACTIVE' || operation.error === 'AI_DATA_MIGRATION_ACTIVE') {
            addToastRef.current(operationErrorMessage(translateRef.current, operation.error, operation.details), 'error');
          }
        }
        return;
      }
      const pendingOperation = pendingOperationRef.current;
      if (!pendingOperation || operation.requestId !== pendingOperation.requestId
        || operation.operation !== pendingOperation.operation) return;
      pendingOperationRef.current = null;
      setPending(null);
      if (operationTimeoutRef.current) clearTimeout(operationTimeoutRef.current);
      operationTimeoutRef.current = null;
      if (operation.status) setStatus(operation.status);
      if (operation.success) {
        if (operation.operation === 'migrate') {
          addToastRef.current(translateRef.current('settings.storage.migrateSuccess'), 'success');
        }
        if (operation.operation === 'cleanup') {
          addToastRef.current(translateRef.current('settings.storage.cleanupSuccess'), 'success');
        }
      } else {
        addToastRef.current(operationErrorMessage(translateRef.current, operation.error, operation.details), 'error');
      }
    });
    aiDataStorageBridge.getStatus();
    return () => {
      unsubscribeStatus();
      unsubscribeRoot();
      unsubscribeOperation();
      pendingOperationRef.current = null;
      if (operationTimeoutRef.current) clearTimeout(operationTimeoutRef.current);
    };
  }, []);

  const requestMigration = () => {
    const normalized = targetRoot.trim();
    if (!normalized || pending !== null || status?.supported !== true || statusBusy) return;
    setConfirmation({ operation: 'migrate', targetRoot: normalized });
  };

  const requestCleanup = () => {
    if (pending !== null || status?.supported !== true || statusBusy) return;
    setConfirmation({ operation: 'cleanup' });
  };

  const confirmOperation = () => {
    if (!confirmation || pending !== null || status?.supported !== true || statusBusy) return;
    setConfirmation(null);
    const operation = confirmation.operation;
    const requestId = createRequestId();
    pendingOperationRef.current = { operation, requestId };
    setPending(operation);
    if (operationTimeoutRef.current) clearTimeout(operationTimeoutRef.current);
    operationTimeoutRef.current = setTimeout(() => {
      if (pendingOperationRef.current?.requestId !== requestId) return;
      pendingOperationRef.current = null;
      setPending(null);
      operationTimeoutRef.current = null;
      addToastRef.current(translateRef.current('settings.storage.operationTimeout'), 'error');
      aiDataStorageBridge.getStatus();
    }, OPERATION_TIMEOUT_MS);
    if (confirmation.operation === 'migrate') {
      const sent = aiDataStorageBridge.migrate(confirmation.targetRoot, requestId);
      if (sent === false) {
        if (pendingOperationRef.current?.requestId === requestId) {
          pendingOperationRef.current = null;
          setPending(null);
        }
        if (operationTimeoutRef.current) clearTimeout(operationTimeoutRef.current);
        operationTimeoutRef.current = null;
        addToastRef.current(translateRef.current('settings.storage.operationFailed'), 'error');
        aiDataStorageBridge.getStatus();
      }
    } else {
      const sent = aiDataStorageBridge.cleanupBackups(requestId);
      if (sent === false) {
        if (pendingOperationRef.current?.requestId === requestId) {
          pendingOperationRef.current = null;
          setPending(null);
        }
        if (operationTimeoutRef.current) clearTimeout(operationTimeoutRef.current);
        operationTimeoutRef.current = null;
        addToastRef.current(translateRef.current('settings.storage.operationFailed'), 'error');
        aiDataStorageBridge.getStatus();
      }
    }
  };

  const directoryCount = status?.directories.length ?? 0;
  const linkedCount = status?.directories.filter((entry) => entry.state === 'linked').length ?? 0;
  const allLinked = directoryCount > 0 && linkedCount === directoryCount;
  const currentStorageSelected = Boolean(status?.storageRoot)
    && comparablePath(targetRoot, status?.platform) === comparablePath(status?.storageRoot ?? '', status?.platform);
  const migrationTarget = confirmation?.operation === 'migrate' ? confirmation.targetRoot : null;
  const confirmationIsMigration = migrationTarget !== null;
  const statusBusy = status?.migrationInProgress === true
    || status?.error === 'AI_PROCESSES_ACTIVE' || status?.error === 'AI_DATA_MIGRATION_ACTIVE';

  return (
    <div className={styles.section}>
      <h3 className={styles.title}>{t('settings.storage.title')}</h3>
      <p className={styles.description}>{t('settings.storage.description')}</p>

      <CodexStoragePanel addToast={addToast} />

      {status?.wsl && (
        <div className={styles.warning}>
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('settings.storage.wslUnsupported')}</span>
        </div>
      )}
      {status && !status.supported && !status.wsl && (
        <div className={styles.warning}>
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{t('settings.storage.windowsOnly')}</span>
        </div>
      )}
      {statusBusy && (
        <div className={styles.warning} role="status">
          <span className="codicon codicon-warning" aria-hidden="true" />
          <span>{operationErrorMessage(t, status?.error, status?.migrationOwner)}</span>
        </div>
      )}
      <details className={styles.group}>
        <summary className={styles.groupHeader}>
          <span className="codicon codicon-folder-opened" aria-hidden="true" />
          <h4>{t('settings.storage.directorySettings')}</h4>
          <span className={styles.groupMeta}>{status
            ? t('settings.storage.statusSummary', { linked: linkedCount, total: directoryCount })
            : t('common.loading')}</span>
          <span className={`codicon codicon-chevron-right ${styles.chevron}`} aria-hidden="true" />
        </summary>
        <div className={styles.groupBody}>
          <div className={styles.directoryListHeader}>
            <div className={styles.directorySummary}>
              <h4>{t('settings.storage.statusTitle')}</h4>
              {status && (
                <span>{t('settings.storage.statusSummary', { linked: linkedCount, total: directoryCount })}</span>
              )}
            </div>
            <button
              type="button"
              className={styles.refreshButton}
              onClick={aiDataStorageBridge.getStatus}
              disabled={pending !== null}
              title={t('common.refresh')}
              aria-label={t('common.refresh')}
            >
              <span className="codicon codicon-refresh" aria-hidden="true" />
            </button>
          </div>
          <div className={styles.directoryList}>
            {status?.directories.map((entry) => (
              <div key={entry.id} className={styles.directoryRow}>
                <div className={styles.directoryIdentity}>
                  <strong>.{entry.id}</strong>
                  <span className={`${styles.state} ${styles[`state_${entry.state}`]}`}>
                    {t(`settings.storage.states.${entry.state}`)}
                  </span>
                </div>
                <div className={styles.pathList}>
                  <div className={styles.pathLine} title={entry.canonicalPath}>
                    <span>{t('settings.storage.canonicalPath')}</span>
                    <code>{entry.canonicalPath}</code>
                  </div>
                  {entry.physicalPath && (
                    <div className={styles.pathLine} title={entry.physicalPath}>
                      <span>{t('settings.storage.physicalPath')}</span>
                      <code>{entry.physicalPath}</code>
                    </div>
                  )}
                </div>
              </div>
            )) ?? <div className={styles.loading}>{t('common.loading')}</div>}
          </div>

          <label className={styles.targetField}>
            <span>{allLinked ? t('settings.storage.currentRoot') : t('settings.storage.targetRoot')}</span>
            <div className={styles.targetRow}>
              <input
                type="text"
                value={targetRoot}
                maxLength={2048}
                disabled={pending !== null || status?.supported !== true || statusBusy}
                onChange={(event) => setTargetRoot(event.target.value)}
                placeholder={t('settings.storage.targetPlaceholder')}
              />
              <button
                type="button"
                className={styles.iconButton}
                onClick={aiDataStorageBridge.chooseRoot}
                disabled={pending !== null || status?.supported !== true || statusBusy}
                title={t('settings.storage.chooseRoot')}
                aria-label={t('settings.storage.chooseRoot')}
              >
                <span className="codicon codicon-folder-opened" aria-hidden="true" />
              </button>
            </div>
          </label>

          <p className={styles.hint}>
            <span className="codicon codicon-info" aria-hidden="true" />
            <span>{t('settings.storage.migrationHint')}</span>
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={requestMigration}
              disabled={!targetRoot.trim() || pending !== null || status?.supported !== true || currentStorageSelected || statusBusy}
            >
              <span className="codicon codicon-move" aria-hidden="true" />
              {pending === 'migrate'
                ? t('settings.storage.migrating')
                : currentStorageSelected
                  ? t('settings.storage.alreadyMigrated')
                  : t('settings.storage.migrate')}
            </button>
            {(status?.backupCount ?? 0) > 0 && (
              <button
                type="button"
                className={styles.dangerButton}
                onClick={requestCleanup}
                disabled={pending !== null || status?.supported !== true || statusBusy}
              >
                <span className="codicon codicon-trash" aria-hidden="true" />
                {pending === 'cleanup'
                  ? t('settings.storage.cleaning')
                  : t('settings.storage.cleanupBackups', { count: status?.backupCount ?? 0 })}
              </button>
            )}
          </div>
        </div>
      </details>

      {confirmation ? createPortal(<div className={styles.dialog}><ConfirmDialog
        isOpen={confirmation !== null}
        title={confirmationIsMigration
          ? t('settings.storage.migrateConfirmTitle')
          : t('settings.storage.cleanupConfirmTitle')}
        message={confirmationIsMigration
          ? t('settings.storage.migrateConfirm')
          : t('settings.storage.cleanupConfirm')}
        confirmText={confirmationIsMigration
          ? t('settings.storage.confirmMigration')
          : t('settings.storage.deleteBackups')}
        cancelText={t('common.cancel')}
        onConfirm={confirmOperation}
        onCancel={() => setConfirmation(null)}
        danger={!confirmationIsMigration}
      >
        {confirmationIsMigration && (
          <div className={styles.confirmDetails}>
            <span>{t('settings.storage.targetRoot')}</span>
            <code title={migrationTarget}>{migrationTarget}</code>
            <div className={styles.confirmWarning}>
              <span className="codicon codicon-warning" aria-hidden="true" />
              <span>{t('settings.storage.migrationWarning')}</span>
            </div>
          </div>
        )}
      </ConfirmDialog></div>, document.body) : null}
    </div>
  );
}
