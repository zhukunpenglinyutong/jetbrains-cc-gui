import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ProviderBackupDialog, { type ProviderBackupMode } from '../ProviderBackupDialog';
import styles from './style.module.less';

interface ProviderListHeaderProps {
  importMenuOpen: boolean;
  importMenuRef: React.RefObject<HTMLDivElement | null>;
  onToggleImportMenu: () => void;
  onPreviewImport: () => void;
  onSelectFile: () => void;
  onAdd: () => void;
  addToast: React.ComponentProps<typeof ProviderBackupDialog>['addToast'];
}

/** Section header with the title, import menu and add-provider button. */
export default function ProviderListHeader({
  importMenuOpen,
  importMenuRef,
  onToggleImportMenu,
  onPreviewImport,
  onSelectFile,
  onAdd,
  addToast,
}: ProviderListHeaderProps) {
  const { t } = useTranslation();
  const [backupMode, setBackupMode] = useState<ProviderBackupMode | null>(null);

  return (
    <div className={styles.header}>
      {backupMode && <ProviderBackupDialog engine="claude" mode={backupMode}
        onClose={() => setBackupMode(null)} addToast={addToast} />}
      <h4 className={styles.title}>{t('settings.provider.allProviders')}</h4>

      <div className={styles.actions}>
        <div className={styles.importMenuWrapper} ref={importMenuRef}>
          <button
            className={styles.btnSecondary}
            onClick={onToggleImportMenu}
          >
            <span className="codicon codicon-cloud-download" />
            {t('settings.provider.import')}
          </button>

          {importMenuOpen && (
            <div className={styles.importMenu}>
              <button type="button" className={styles.importMenuItem} onClick={() => {
                onToggleImportMenu();
                setBackupMode('import');
              }}>
                <span className="codicon codicon-file" />
                {t('settings.provider.backup.importFile')}
              </button>
              <div
                className={styles.importMenuItem}
                onClick={onPreviewImport}
              >
                <span className="codicon codicon-arrow-swap" />
                {t('settings.provider.importFromCcSwitchUpdate')}
              </div>
              <div
                className={styles.importMenuItem}
                onClick={onSelectFile}
              >
                <span className="codicon codicon-file" />
                {t('settings.provider.importFromCcSwitchFile')}
              </div>
              {/* <div
                className={styles.importMenuItem}
                onClick={() => {
                  setImportMenuOpen(false);
                  addToast(t('settings.provider.featureComingSoon'), 'info');
                }}
              >
                <span className="codicon codicon-arrow-swap" />
                {t('settings.provider.importFromCcSwitchCli')}
              </div>
              <div
                className={styles.importMenuItem}
                onClick={() => {
                  setImportMenuOpen(false);
                  addToast(t('settings.provider.featureComingSoon'), 'info');
                }}
              >
                <span className="codicon codicon-arrow-swap" />
                {t('settings.provider.importFromClaudeRouter')}
              </div> */}
            </div>
          )}
        </div>

        <button type="button" className={styles.btnSecondary} onClick={() => setBackupMode('export')}>
          <span className="codicon codicon-cloud-upload" />
          {t('settings.provider.backup.export')}
        </button>

        <button
          className={styles.btnPrimary}
          onClick={onAdd}
        >
          <span className="codicon codicon-add" />
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}
