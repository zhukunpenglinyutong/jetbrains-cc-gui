import { useTranslation } from 'react-i18next';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import type { AiFeatureProvider } from '../../../types/aiFeatureConfig';
import { isAiFeatureProvider } from '../../../types/aiFeatureConfig';
import FeatureSelect, { type SelectOption } from './FeatureSelect';
import styles from './style.module.less';

const ManualSelection = ({
  settingsKeyPrefix,
  providerKeyPrefix,
  statusProvider,
  resolutionUnavailable,
  selectedProvider,
  providerOptions,
  onProviderChange,
  modelValue,
  modelOptions,
  onModelChange,
  currentModel,
}: {
  settingsKeyPrefix: string;
  providerKeyPrefix: string;
  statusProvider: AiFeatureProvider;
  resolutionUnavailable: boolean;
  selectedProvider: AiFeatureProvider;
  providerOptions: SelectOption[];
  onProviderChange: (provider: AiFeatureProvider) => void;
  modelValue: string;
  modelOptions: SelectOption[];
  onModelChange: (model: string) => void;
  currentModel: string;
}) => {
  const { t } = useTranslation();

  const statusProviderLabel = t(`providers.${statusProvider}.label`, {
    defaultValue: t(`${providerKeyPrefix}.${statusProvider}`, { defaultValue: statusProvider }),
  });

  const manualStatusText = resolutionUnavailable
    ? t(`${settingsKeyPrefix}.currentProviderUnavailable`, {
      provider: statusProviderLabel,
    })
    : null;

  return (
    <>
      <div className={styles.selectGroup}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t(`${settingsKeyPrefix}.label`)}</span>
          <FeatureSelect
            value={selectedProvider}
            options={providerOptions}
            onChange={(value) => {
              if (isAiFeatureProvider(value)) {
                onProviderChange(value);
              }
            }}
            ariaLabel={t(`${settingsKeyPrefix}.label`)}
            testId="ai-feature-provider-select"
            icon={(
              <span data-testid="provider-select-icon">
                <ProviderModelIcon providerId={selectedProvider} size={14} colored />
              </span>
            )}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t(`${settingsKeyPrefix}.modelLabel`)}</span>
          <FeatureSelect
            value={modelValue}
            options={modelOptions}
            onChange={onModelChange}
            disabled={modelOptions.length === 0}
            ariaLabel={t(`${settingsKeyPrefix}.modelLabel`)}
            testId="ai-feature-model-select"
            icon={(
              <ProviderModelIcon
                providerId={selectedProvider}
                modelId={currentModel}
                size={14}
                colored
              />
            )}
          />
        </div>
      </div>

      {manualStatusText && (
        <div
          className={`${styles.statusHint} ${styles.statusHintWarn}`}
          data-testid="ai-feature-status-hint"
        >
          <span className="codicon codicon-warning" />
          <span className={styles.statusText} title={manualStatusText}>{manualStatusText}</span>
        </div>
      )}
    </>
  );
};

export default ManualSelection;
