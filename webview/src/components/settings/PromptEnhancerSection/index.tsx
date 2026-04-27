import { useTranslation } from 'react-i18next';
import type { PromptEnhancerConfig, PromptEnhancerProvider } from '../../../types/promptEnhancer';
import { DEFAULT_PROMPT_ENHANCER_CONFIG } from '../../../types/promptEnhancer';
import AiFeatureProviderModelPanel from '../AiFeatureProviderModelPanel';
import AiFeatureSettingsCard from '../AiFeatureSettingsCard';
import styles from './style.module.less';

interface PromptEnhancerSectionProps {
  promptEnhancerConfig?: PromptEnhancerConfig;
  onPromptEnhancerProviderChange?: (provider: PromptEnhancerProvider) => void;
  onPromptEnhancerModelChange?: (model: string) => void;
  onPromptEnhancerResetToDefault?: () => void;
}

const PromptEnhancerSection = ({
  promptEnhancerConfig = DEFAULT_PROMPT_ENHANCER_CONFIG,
  onPromptEnhancerProviderChange = () => {},
  onPromptEnhancerModelChange = () => {},
  onPromptEnhancerResetToDefault = () => {},
}: PromptEnhancerSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <AiFeatureSettingsCard
        title={t('settings.promptEnhancer.title')}
        description={t('settings.promptEnhancer.description')}
        testId="prompt-enhancer-provider-card"
      >
        <AiFeatureProviderModelPanel
          config={promptEnhancerConfig}
          settingsKeyPrefix="settings.basic.promptEnhancer"
          providerKeyPrefix="settings.basic.promptEnhancer.provider"
          fallbackProvider="claude"
          onProviderChange={onPromptEnhancerProviderChange}
          onModelChange={onPromptEnhancerModelChange}
          onResetToDefault={onPromptEnhancerResetToDefault}
        />
      </AiFeatureSettingsCard>
    </div>
  );
};

export default PromptEnhancerSection;
