import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

interface FontSizeSectionProps {
  fontSizeLevel: number;
  onFontSizeLevelChange: (level: number) => void;
}

const FontSizeSection = ({ fontSizeLevel, onFontSizeLevelChange }: FontSizeSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.fontSizeSection}>
      <div className={styles.fieldHeader}>
        <span className="codicon codicon-text-size" />
        <span className={styles.fieldLabel}>{t('settings.basic.fontSize.label')}</span>
      </div>
      <select
        className={styles.fontSizeSelect}
        value={fontSizeLevel}
        onChange={(e) => onFontSizeLevelChange(Number(e.target.value))}
      >
        <option value={1}>{t('settings.basic.fontSize.level1')}</option>
        <option value={2}>{t('settings.basic.fontSize.level2')}</option>
        <option value={3}>{t('settings.basic.fontSize.level3')}</option>
        <option value={4}>{t('settings.basic.fontSize.level4')}</option>
        <option value={5}>{t('settings.basic.fontSize.level5')}</option>
        <option value={6}>{t('settings.basic.fontSize.level6')}</option>
      </select>
    </div>
  );
};

export default FontSizeSection;
