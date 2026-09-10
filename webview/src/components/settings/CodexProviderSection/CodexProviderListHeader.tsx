import { useTranslation } from 'react-i18next';
import sharedStyles from '../ProviderList/style.module.less';

interface CodexProviderListHeaderProps {
  importMenuRef: React.RefObject<HTMLDivElement | null>;
  importMenuOpen: boolean;
  onToggleImportMenu: () => void;
  onPreviewImport: () => void;
  onSelectFileClick: () => void;
  onAddCodexProvider: () => void;
}

const CodexProviderListHeader = ({
  importMenuRef,
  importMenuOpen,
  onToggleImportMenu,
  onPreviewImport,
  onSelectFileClick,
  onAddCodexProvider,
}: CodexProviderListHeaderProps) => {
  const { t } = useTranslation();

  return (
    <div className={sharedStyles.header}>
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
