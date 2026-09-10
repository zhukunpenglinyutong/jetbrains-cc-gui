import { useTranslation } from 'react-i18next';
import sharedStyles from '../ProviderList/style.module.less';

const ICON_MR_8_STYLE: React.CSSProperties = { marginRight: '8px' };

interface CliLoginCardProps {
  isActive: boolean;
  onShowHelp: () => void;
  onRequestAuthorize: () => void;
  onRequestDisable: () => void;
}

const CliLoginCard = ({
  isActive,
  onShowHelp,
  onRequestAuthorize,
  onRequestDisable,
}: CliLoginCardProps) => {
  const { t } = useTranslation();

  return (
    <div
      className={`${sharedStyles.card} ${isActive ? sharedStyles.active : ''} ${sharedStyles.localProviderCard}`}
    >
      <div className={sharedStyles.cardInfo}>
        <div className={sharedStyles.name}>
          <span className="codicon codicon-key" style={ICON_MR_8_STYLE} />
          <span className={sharedStyles.nameText}>{t('settings.codexProvider.dialog.cliLoginProviderName')}</span>
          <button
            type="button"
            className={sharedStyles.nameInfoIcon}
            onClick={(e) => { e.stopPropagation(); onShowHelp(); }}
            title={t('settings.provider.whatIsThis')}
            aria-label={t('settings.provider.whatIsThis')}
          >
            <span className="codicon codicon-info" />
          </button>
        </div>
      </div>

      <div className={sharedStyles.cardActions}>
        {isActive ? (
          <button
            className={sharedStyles.revokeButton}
            onClick={onRequestDisable}
          >
            <span className="codicon codicon-circle-slash" />
            {t('settings.provider.revokeAuthorization')}
          </button>
        ) : (
          <button
            className={sharedStyles.useButton}
            onClick={onRequestAuthorize}
          >
            <span className="codicon codicon-play" />
            {t('settings.provider.authorizeAndEnable')}
          </button>
        )}
      </div>
    </div>
  );
};

export default CliLoginCard;
