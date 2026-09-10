import { useTranslation } from 'react-i18next';

interface ProviderCliFooterProps {
  onOpenCliSettings: () => void;
}

/**
 * ProviderCliFooter - dropdown footer button opening Settings → Providers → CLI management
 */
export const ProviderCliFooter = ({ onOpenCliSettings }: ProviderCliFooterProps) => {
  const { t } = useTranslation();

  return (
    <div className="provider-cli-footer">
      <button
        type="button"
        className="provider-cli-footer-btn"
        onClick={onOpenCliSettings}
      >
        <span className="codicon codicon-settings" />
        <span>{t('providers.manageCli', { defaultValue: 'CLI Settings' })}</span>
      </button>
    </div>
  );
};

export default ProviderCliFooter;
