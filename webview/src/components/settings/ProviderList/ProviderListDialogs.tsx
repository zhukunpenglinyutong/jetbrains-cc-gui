import { useTranslation } from 'react-i18next';
import styles from './style.module.less';

interface EditCcSwitchDialogProps {
  onCancel: () => void;
  onContinue: () => void;
  onConvert: () => void;
}

/** Warning shown before editing a provider that is managed by cc-switch. */
export function EditCcSwitchDialog({ onCancel, onContinue, onConvert }: EditCcSwitchDialogProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.warningOverlay}>
        <div className={styles.warningDialog}>
            <div className={styles.warningTitle}>
                <span className="codicon codicon-warning" />
                {t('settings.provider.editCcSwitchTitle')}
            </div>
            <div className={styles.warningContent}>
                {t('settings.provider.editCcSwitchWarning')}
            </div>
            <div className={styles.warningActions}>
                <button
                    className={styles.btnSecondary}
                    onClick={onCancel}
                >
                    {t('common.cancel')}
                </button>
                <button
                    className={styles.btnSecondary}
                    onClick={onContinue}
                >
                    {t('settings.provider.continueEdit')}
                </button>
                <button
                    className={styles.btnWarning}
                    onClick={onConvert}
                >
                    {t('settings.provider.convertAndEdit')}
                </button>
            </div>
        </div>
    </div>
  );
}

interface ConvertConfirmDialogProps {
  providerName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Confirmation for converting a cc-switch provider into a plugin-local one. */
export function ConvertConfirmDialog({ providerName, onCancel, onConfirm }: ConvertConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.warningOverlay}>
        <div className={styles.warningDialog}>
            <div className={styles.warningTitle}>
                <span className="codicon codicon-arrow-swap" />
                {t('settings.provider.convertToPlugin')}
            </div>
            <div className={styles.warningContent}>
                {t('settings.provider.convertConfirmMessage', { name: providerName })}<br/><br/>
                {t('settings.provider.convertDetailMessage')}
            </div>
            <div className={styles.warningActions}>
                <button
                    className={styles.btnSecondary}
                    onClick={onCancel}
                >
                    {t('common.cancel')}
                </button>
                <button
                    className={styles.btnPrimary}
                    onClick={onConfirm}
                >
                    {t('settings.provider.confirmConvert')}
                </button>
            </div>
        </div>
    </div>
  );
}

interface AuthorizeDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
}

/** Authorization prompt for enabling the local settings-file provider. */
export function LocalProviderAuthorizeDialog({ onCancel, onConfirm }: AuthorizeDialogProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.warningOverlay}>
      <div className={styles.warningDialog}>
        <div className={styles.warningTitle}>
          <span className="codicon codicon-shield" />
          {t('settings.provider.localProviderAuthorizeTitle')}
        </div>
        <div className={styles.warningContent}>
          {t('settings.provider.localProviderAuthorizeMessage')}
          <br />
          <br />
          {t('settings.provider.localProviderAuthorizeDetail')}
        </div>
        <div className={styles.warningActions}>
          <button
            className={styles.btnSecondary}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className={styles.btnPrimary}
            onClick={onConfirm}
          >
            {t('settings.provider.authorizeAndEnable')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Confirmation for revoking the local settings-file provider authorization. */
export function LocalProviderDisableDialog({ onCancel, onConfirm }: AuthorizeDialogProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.warningOverlay}>
      <div className={styles.warningDialog}>
        <div className={styles.warningTitle}>
          <span className="codicon codicon-circle-slash" />
          {t('settings.provider.localProviderDisableTitle')}
        </div>
        <div className={styles.warningContent}>
          {t('settings.provider.localProviderDisableMessage')}
        </div>
        <div className={styles.warningActions}>
          <button
            className={styles.btnSecondary}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className={styles.btnDanger}
            onClick={onConfirm}
          >
            {t('settings.provider.revokeAuthorization')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Authorization prompt for enabling the CLI login provider. */
export function CliLoginAuthorizeDialog({ onCancel, onConfirm }: AuthorizeDialogProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.warningOverlay}>
      <div className={styles.warningDialog}>
        <div className={styles.warningTitle}>
          <span className="codicon codicon-key" />
          {t('settings.provider.cliLoginAuthorizeTitle')}
        </div>
        <div className={styles.warningContent}>
          {t('settings.provider.cliLoginAuthorizeMessage')}
          <br />
          <br />
          {t('settings.provider.cliLoginAuthorizeDetail')}
        </div>
        <div className={styles.warningActions}>
          <button
            className={styles.btnSecondary}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className={styles.btnPrimary}
            onClick={onConfirm}
          >
            {t('settings.provider.authorizeAndEnable')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Confirmation for revoking the CLI login provider authorization. */
export function CliLoginDisableDialog({ onCancel, onConfirm }: AuthorizeDialogProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.warningOverlay}>
      <div className={styles.warningDialog}>
        <div className={styles.warningTitle}>
          <span className="codicon codicon-circle-slash" />
          {t('settings.provider.cliLoginDisableTitle')}
        </div>
        <div className={styles.warningContent}>
          {t('settings.provider.cliLoginDisableMessage')}
        </div>
        <div className={styles.warningActions}>
          <button
            className={styles.btnSecondary}
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className={styles.btnDanger}
            onClick={onConfirm}
          >
            {t('settings.provider.revokeAuthorization')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface HelpDialogProps {
  kind: 'local' | 'cli';
  onClose: () => void;
}

/** Informational dialog explaining what a special provider is. */
export function HelpDialog({ kind, onClose }: HelpDialogProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.warningOverlay}>
      <div className={styles.warningDialog}>
        <div className={styles.warningTitle}>
          <span className="codicon codicon-info" />
          {kind === 'local'
            ? t('settings.provider.localProviderHelpTitle')
            : t('settings.provider.cliLoginHelpTitle')}
        </div>
        <div className={styles.warningContent} style={{ whiteSpace: 'pre-wrap' }}>
          {kind === 'local'
            ? t('settings.provider.localProviderHelpBody')
            : t('settings.provider.cliLoginHelpBody')}
        </div>
        <div className={styles.warningActions}>
          <button
            className={styles.btnPrimary}
            onClick={onClose}
          >
            {t('common.gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
