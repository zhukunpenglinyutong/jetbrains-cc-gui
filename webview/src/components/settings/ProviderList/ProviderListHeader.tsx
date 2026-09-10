import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

interface ProviderListHeaderProps {
  importMenuOpen: boolean;
  importMenuRef: React.RefObject<HTMLDivElement | null>;
  onToggleImportMenu: () => void;
  onPreviewImport: () => void;
  onSelectFile: () => void;
  onAdd: () => void;
}

/** Section header with the title, import menu and add-provider button. */
export default function ProviderListHeader({
  importMenuOpen,
  importMenuRef,
  onToggleImportMenu,
  onPreviewImport,
  onSelectFile,
  onAdd,
}: ProviderListHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.header}>
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
