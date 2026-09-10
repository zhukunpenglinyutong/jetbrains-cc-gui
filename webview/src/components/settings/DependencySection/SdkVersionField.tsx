import { useTranslation } from 'react-i18next';
import VersionSelect from './VersionSelect';
import styles from './style.module.less';

interface SdkVersionFieldProps {
  selectedVersion: string;
  versionOptions: string[];
  isVersionLoading: boolean;
  isAnyOperationInProgress: boolean;
  targetVersionLabel: string;
  onVersionChange: (version: string) => void;
}

const SdkVersionField = ({
  selectedVersion,
  versionOptions,
  isVersionLoading,
  isAnyOperationInProgress,
  targetVersionLabel,
  onVersionChange,
}: SdkVersionFieldProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.versionField}>
      <span className={styles.versionLabelInline}>{t('settings.dependency.targetVersion')}</span>
      <VersionSelect
        value={selectedVersion}
        options={versionOptions}
        disabled={isAnyOperationInProgress || isVersionLoading || versionOptions.length === 0}
        label={t('settings.dependency.targetVersion')}
        valueLabel={targetVersionLabel}
        onChange={onVersionChange}
      />
    </div>
  );
};

export default SdkVersionField;
