import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

interface OtherSettingsSectionProps {
  historyCompletionEnabled: boolean;
  onHistoryCompletionEnabledChange: (enabled: boolean) => void;
}

const OtherSettingsSection = ({
  historyCompletionEnabled,
  onHistoryCompletionEnabledChange,
}: OtherSettingsSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.other.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.other.description')}</p>

      {/* 历史输入补全开关 */}
      <div className={styles.historyCompletionSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-history" />
          <span className={styles.fieldLabel}>{t('settings.other.historyCompletion.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={historyCompletionEnabled}
            onChange={(e) => onHistoryCompletionEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {historyCompletionEnabled
              ? t('settings.other.historyCompletion.enabled')
              : t('settings.other.historyCompletion.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.other.historyCompletion.hint')}</span>
        </small>
      </div>
    </div>
  );
};

export default OtherSettingsSection;
