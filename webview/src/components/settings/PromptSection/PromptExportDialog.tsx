import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { PromptConfig } from '../../../types/prompt';
import styles from '../ProviderList/style.module.less';

interface PromptExportDialogProps {
  prompts: PromptConfig[];
  onConfirm: (selectedIds: string[]) => void;
  onCancel: () => void;
}

export default function PromptExportDialog({
  prompts,
  onConfirm,
  onCancel
}: PromptExportDialogProps) {
  const { t } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(prompts.map(prompt => prompt.id))
  );
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
    if (selectedIds.size === prompts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(prompts.map(prompt => prompt.id)));
    }
  };

  const handleConfirm = () => {
    if (selectedIds.size === 0) {
      return;
    }
    onConfirm(Array.from(selectedIds));
  };

  if (!mounted) return null;

  return createPortal(
    <div className={styles.overlay} onClick={(e) => {
        if (e.target === e.currentTarget) {
            onCancel();
        }
    }}>
      <div className={styles.dialog}>
        <div className={styles.dialogHeader}>
          <h3>{t('settings.prompt.exportDialog.title')}</h3>
          <button className={styles.closeBtn} onClick={onCancel}>
            <span className="codicon codicon-close" />
          </button>
        </div>

        <div className={styles.dialogContent}>
          <div className={styles.summary}>
            {t('settings.prompt.exportDialog.selectHint')}
          </div>

          <div className={styles.tableHeader}>
            <div className={styles.colCheckbox}>
              <input
                type="checkbox"
                checked={selectedIds.size === prompts.length && prompts.length > 0}
                onChange={toggleAll}
              />
            </div>
            <div className={styles.colName}>{t('settings.prompt.importDialog.columnName')}</div>
            <div className={styles.colId}>{t('settings.prompt.importDialog.columnId')}</div>
          </div>

          <div className={styles.providerList}>
            {prompts.map(prompt => {
              const isSelected = selectedIds.has(prompt.id);

              return (
                <div
                  key={prompt.id}
                  className={`${styles.providerRow} ${isSelected ? styles.selected : ''}`}
                  onClick={() => toggleSelect(prompt.id)}
                >
                  <div className={styles.colCheckbox}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // handled by row click
                    />
                  </div>
                  <div className={styles.colName}>{prompt.name}</div>
                  <div className={styles.colId}>{prompt.id}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className={styles.dialogFooter}>
          <div className={styles.selectedCount}>
            {t('settings.prompt.importDialog.selectedCount', { count: selectedIds.size })}
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
              {t('settings.prompt.exportDialog.confirmExport')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
