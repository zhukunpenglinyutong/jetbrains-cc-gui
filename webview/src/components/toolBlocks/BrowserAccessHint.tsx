import { useTranslation } from 'react-i18next';

const BrowserAccessHint = () => {
  const { t } = useTranslation();

  return (
    <div className="browser-access-hint" role="note">
      <strong>{t('tools.browserAccessHint.title')}</strong>
      <p>{t('tools.browserAccessHint.description')}</p>
      <p>{t('tools.browserAccessHint.report')}</p>
    </div>
  );
};

export default BrowserAccessHint;
