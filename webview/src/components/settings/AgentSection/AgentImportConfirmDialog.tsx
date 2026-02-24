import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AgentConfig } from '../../../types/agent';
import type { ImportPreviewResult, ConflictStrategy } from '../../../types/import';
import styles from '../ProviderList/style.module.less';

interface AgentImportConfirmDialogProps {
  previewData: ImportPreviewResult<AgentConfig>;
  onConfirm: (selectedIds: string[], strategy: ConflictStrategy) => void;
  onCancel: () => void;
}

export default function AgentImportConfirmDialog({
  previewData,
  onConfirm,
  onCancel
}: AgentImportConfirmDialogProps) {
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(previewData.items.map(item => item.data.id))
  );
  const [strategy, setStrategy] = useState<ConflictStrategy>('skip');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleAll = () => {
    if (selectedIds.size === previewData.items.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(previewData.items.map(item => item.data.id)));
    }
  };

  const handleConfirm = () => {
    onConfirm(Array.from(selectedIds), strategy);
  };

  if (!mounted) return null;

  const hasConflicts = previewData.items.some(item => item.conflict);

  return createPortal(
    <div className={styles.overlay} onClick={(e) => {
        if (e.target === e.currentTarget) {
            onCancel();
        }
    }}>
      <div className={styles.dialog}>
        <div className={styles.dialogHeader}>
          <h3>{t('settings.agent.importDialog.title')}</h3>
          <button className={styles.closeBtn} onClick={onCancel}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className={styles.dialogContent}>
          <div className={styles.summary}>
            {t('settings.agent.importDialog.summary', { total: previewData.summary.total })}
            <span className={styles.newBadge}>
              {t('settings.agent.importDialog.newCount', { count: previewData.summary.newCount })}
            </span>
            ，
            <span className={styles.updateBadge}>
              {t('settings.agent.importDialog.updateCount', { count: previewData.summary.updateCount })}
            </span>
          </div>

          {hasConflicts && (
            <div className={styles.strategySection}>
              <label className={styles.strategyLabel}>
                {t('settings.agent.importDialog.conflictStrategy')}
              </label>
              <div className={styles.strategyOptions}>
                <label className={styles.strategyOption}>
                  <input
                    type="radio"
                    name="strategy"
                    value="skip"
                    checked={strategy === 'skip'}
                    onChange={(e) => setStrategy(e.target.value as ConflictStrategy)}
                  />
                  <span className={styles.strategyText}>
                    <strong>{t('settings.agent.importDialog.strategySkip')}</strong>
                    <span className={styles.strategyDesc}>
                      {t('settings.agent.importDialog.strategySkipDesc')}
                    </span>
                  </span>
                </label>
                <label className={styles.strategyOption}>
                  <input
                    type="radio"
                    name="strategy"
                    value="overwrite"
                    checked={strategy === 'overwrite'}
                    onChange={(e) => setStrategy(e.target.value as ConflictStrategy)}
                  />
                  <span className={styles.strategyText}>
                    <strong>{t('settings.agent.importDialog.strategyOverwrite')}</strong>
                    <span className={styles.strategyDesc}>
                      {t('settings.agent.importDialog.strategyOverwriteDesc')}
                    </span>
                  </span>
                </label>
                <label className={styles.strategyOption}>
                  <input
                    type="radio"
                    name="strategy"
                    value="duplicate"
                    checked={strategy === 'duplicate'}
                    onChange={(e) => setStrategy(e.target.value as ConflictStrategy)}
                  />
                  <span className={styles.strategyText}>
                    <strong>{t('settings.agent.importDialog.strategyDuplicate')}</strong>
                    <span className={styles.strategyDesc}>
                      {t('settings.agent.importDialog.strategyDuplicateDesc')}
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}

          <div className={styles.tableHeader}>
            <div className={styles.colCheckbox}>
              <input
                type="checkbox"
                checked={selectedIds.size === previewData.items.length && previewData.items.length > 0}
                onChange={toggleAll}
              />
            </div>
            <div className={styles.colName}>{t('settings.agent.importDialog.columnName')}</div>
            <div className={styles.colId}>{t('settings.agent.importDialog.columnId')}</div>
            <div className={styles.colStatus}>{t('settings.agent.importDialog.columnStatus')}</div>
          </div>

          <div className={styles.providerList}>
            {previewData.items.map(item => {
              const agent = item.data;
              const isSelected = selectedIds.has(agent.id);
              const statusText = item.status === 'new'
                ? t('settings.agent.importDialog.statusNew')
                : t('settings.agent.importDialog.statusUpdate');

              return (
                <div
                  key={agent.id}
                  className={`${styles.providerRow} ${isSelected ? styles.selected : ''}`}
                  onClick={() => toggleSelect(agent.id)}
                >
                  <div className={styles.colCheckbox}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // handled by row click
                    />
                  </div>
                  <div className={styles.colName}>{agent.name}</div>
                  <div className={styles.colId}>{agent.id}</div>
                  <div className={styles.colStatus}>
                    <span className={item.status === 'new' ? styles.tagNew : styles.tagUpdate}>
                      {statusText}
                    </span>
                    {item.conflict && (
                      <span className={styles.conflictIcon} title={t('settings.agent.importDialog.conflictWarning')}>
                        <span className="codicon codicon-warning" />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.dialogFooter}>
          <div className={styles.selectedCount}>
            {t('settings.agent.importDialog.selectedCount', { count: selectedIds.size })}
          </div>
          <div className={styles.dialogActions}>
            <button className={styles.btnCancel} onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button
              className={styles.btnConfirm}
              onClick={handleConfirm}
              disabled={selectedIds.size === 0}
            >
              {t('settings.agent.importDialog.confirmImport')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
