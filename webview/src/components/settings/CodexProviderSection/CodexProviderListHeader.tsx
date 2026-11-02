import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ProviderBackupDialog, { type ProviderBackupMode } from '../ProviderBackupDialog';
import sharedStyles from '../ProviderList/style.module.less';

interface CodexProviderListHeaderProps {
  importMenuRef: React.RefObject<HTMLDivElement | null>;
  importMenuOpen: boolean;
  onToggleImportMenu: () => void;
  onPreviewImport: () => void;
  onSelectFileClick: () => void;
  onAddCodexProvider: () => void;
  addToast: React.ComponentProps<typeof ProviderBackupDialog>['addToast'];
}

const CodexProviderListHeader = ({
  importMenuRef,
  importMenuOpen,
  onToggleImportMenu,
  onPreviewImport,
  onSelectFileClick,
  onAddCodexProvider,
  addToast,
}: CodexProviderListHeaderProps) => {
  const { t } = useTranslation();
  const [backupMode, setBackupMode] = useState<ProviderBackupMode | null>(null);

  return (
    <div className={sharedStyles.header}>
      {backupMode && <ProviderBackupDialog engine="codex" mode={backupMode}
        onClose={() => setBackupMode(null)} addToast={addToast} />}
      <h4 className={sharedStyles.title}>{t('settings.provider.allProviders')}</h4>
      <div className={sharedStyles.actions}>
        <div className={sharedStyles.importMenuWrapper} ref={importMenuRef}>
          <button
            className={sharedStyles.btnSecondary}
            onClick={onToggleImportMenu}
          >
            <span className="codicon codicon-cloud-download" />
            {t('settings.provider.import')}
          </button>

          {importMenuOpen && (
            <div className={sharedStyles.importMenu}>
              <button type="button" className={sharedStyles.importMenuItem} onClick={() => {
                onToggleImportMenu();
                setBackupMode('import');
              }}>
                <span className="codicon codicon-file" />
                {t('settings.provider.backup.importFile')}
              </button>
              <div
                className={sharedStyles.importMenuItem}
                onClick={onPreviewImport}
              >
                <span className="codicon codicon-arrow-swap" />
                {t('settings.provider.importFromCcSwitchUpdate')}
              </div>
              <div
                className={sharedStyles.importMenuItem}
                onClick={onSelectFileClick}
              >
                <span className="codicon codicon-file" />
                {t('settings.provider.importFromCcSwitchFile')}
              </div>
            </div>
          )}
        </div>

        <button type="button" className={sharedStyles.btnSecondary} onClick={() => setBackupMode('export')}>
          <span className="codicon codicon-cloud-upload" />
          {t('settings.provider.backup.export')}
        </button>

        <button
          className={sharedStyles.btnPrimary}
          onClick={onAddCodexProvider}
        >
          <span className="codicon codicon-add" />
          {t('common.add')}
        </button>
      </div>
    </div>
  );
};

export default CodexProviderListHeader;
