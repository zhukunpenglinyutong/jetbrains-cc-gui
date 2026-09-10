import { useTranslation } from 'react-i18next';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import sharedStyles from '../ProviderList/style.module.less';

interface CodexProviderDialogsProps {
  showCliLoginConfirm: boolean;
  onCloseCliLoginConfirm: () => void;
  showCliLoginDisableConfirm: boolean;
  onCloseCliLoginDisableConfirm: () => void;
  showLocalConfigHelp: boolean;
  onCloseLocalConfigHelp: () => void;
  onSwitchCodexProvider: (id: string) => void;
  onRevokeCodexLocalConfigAuthorization: (fallbackProviderId?: string) => void;
  firstRegularProviderId?: string;
}

const CodexProviderDialogs = ({
  showCliLoginConfirm,
  onCloseCliLoginConfirm,
  showCliLoginDisableConfirm,
  onCloseCliLoginDisableConfirm,
  showLocalConfigHelp,
  onCloseLocalConfigHelp,
  onSwitchCodexProvider,
  onRevokeCodexLocalConfigAuthorization,
  firstRegularProviderId,
}: CodexProviderDialogsProps) => {
  const { t } = useTranslation();

  return (
    <>
      {/* CLI Login authorize confirm dialog */}
      {showCliLoginConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-key" />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginAuthorizeMessage')}
              <br />
              <br />
              {t('settings.codexProvider.dialog.cliLoginAuthorizeDetail')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={onCloseCliLoginConfirm}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnPrimary}
                onClick={() => {
                  onCloseCliLoginConfirm();
                  onSwitchCodexProvider(SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN);
                }}
              >
                {t('settings.provider.authorizeAndEnable')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CLI Login disable confirm dialog */}
      {showCliLoginDisableConfirm && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-circle-slash" />
              {t('settings.codexProvider.dialog.cliLoginDisableTitle')}
            </div>
            <div className={sharedStyles.warningContent}>
              {t('settings.codexProvider.dialog.cliLoginDisableMessage')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnSecondary}
                onClick={onCloseCliLoginDisableConfirm}
              >
                {t('common.cancel')}
              </button>
              <button
                className={sharedStyles.btnDanger}
                onClick={() => {
                  onCloseCliLoginDisableConfirm();
                  onRevokeCodexLocalConfigAuthorization(firstRegularProviderId);
                }}
              >
                {t('settings.provider.revokeAuthorization')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Local config help dialog (opened via the info icon on the local card) */}
      {showLocalConfigHelp && (
        <div className={sharedStyles.warningOverlay}>
          <div className={sharedStyles.warningDialog}>
            <div className={sharedStyles.warningTitle}>
              <span className="codicon codicon-info" />
              {t('settings.codexProvider.dialog.cliLoginProviderName')}
            </div>
            <div className={sharedStyles.warningContent} style={{ whiteSpace: 'pre-wrap' }}>
              {t('settings.codexProvider.dialog.cliLoginProviderDescription')}
            </div>
            <div className={sharedStyles.warningActions}>
              <button
                className={sharedStyles.btnPrimary}
                onClick={onCloseLocalConfigHelp}
              >
                {t('common.gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CodexProviderDialogs;
