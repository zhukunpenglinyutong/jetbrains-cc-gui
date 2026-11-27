import { useTranslation } from 'react-i18next';
import { APP_VERSION } from '../../version/version';

const BrowserAccessHint = () => {
  const { t } = useTranslation();

  return (
    <div className="browser-access-hint" role="note">
      <strong>{t('tools.browserAccessHint.title')}</strong>
      <p>{t('tools.browserAccessHint.description', { version: APP_VERSION })}</p>
      <p>{t('tools.browserAccessHint.optionsTitle')}</p>
      <ul>
        <li>{t('tools.browserAccessHint.desktopOption')}</li>
        <li>{t('tools.browserAccessHint.manualOption')}</li>
      </ul>
      <p>{t('tools.browserAccessHint.note')}</p>
    </div>
  );
};

export default BrowserAccessHint;
