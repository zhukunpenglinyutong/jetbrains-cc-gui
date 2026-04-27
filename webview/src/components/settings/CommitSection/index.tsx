import styles from './style.module.less';
import { useTranslation } from 'react-i18next';
import type { CommitAiConfig, CommitAiProvider } from '../../../types/aiFeatureConfig';
import { DEFAULT_COMMIT_AI_CONFIG } from '../../../types/aiFeatureConfig';
import AiFeatureProviderModelPanel from '../AiFeatureProviderModelPanel';
import AiFeatureSettingsCard from '../AiFeatureSettingsCard';

interface CommitSectionProps {
  commitAiConfig?: CommitAiConfig;
  onCommitAiProviderChange?: (provider: CommitAiProvider) => void;
  onCommitAiModelChange?: (model: string) => void;
  onCommitAiResetToDefault?: () => void;
  commitPrompt: string;
  onCommitPromptChange: (prompt: string) => void;
  onSaveCommitPrompt: () => void;
  savingCommitPrompt: boolean;
}

const CommitSection = ({
  commitAiConfig = DEFAULT_COMMIT_AI_CONFIG,
  onCommitAiProviderChange = () => {},
  onCommitAiModelChange = () => {},
  onCommitAiResetToDefault = () => {},
  commitPrompt,
  onCommitPromptChange,
  onSaveCommitPrompt,
  savingCommitPrompt,
}: CommitSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <AiFeatureSettingsCard
        title={t('settings.commit.title')}
        description={t('settings.commit.description')}
        testId="commit-ai-provider-card"
      >
        <AiFeatureProviderModelPanel
          config={commitAiConfig}
          settingsKeyPrefix="settings.commit.providerModel"
          providerKeyPrefix="settings.basic.promptEnhancer.provider"
          fallbackProvider="codex"
          onProviderChange={onCommitAiProviderChange}
          onModelChange={onCommitAiModelChange}
          onResetToDefault={onCommitAiResetToDefault}
        />
      </AiFeatureSettingsCard>

      {/* Commit AI prompt configuration */}
      <div className={styles.promptSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-edit" />
          <span className={styles.fieldLabel}>{t('settings.commit.prompt.label')}</span>
        </div>
        <div className={styles.promptInputWrapper}>
          <textarea
            className={styles.promptTextarea}
            placeholder={t('settings.commit.prompt.placeholder')}
            value={commitPrompt}
            onChange={(e) => onCommitPromptChange(e.target.value)}
            rows={6}
          />
          <button
            className={styles.saveBtn}
            onClick={onSaveCommitPrompt}
            disabled={savingCommitPrompt}
          >
            {savingCommitPrompt && (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            )}
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.commit.prompt.hint')}</span>
        </small>
      </div>
    </div>
  );
};

export default CommitSection;
