import styles from './style.module.less';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  CommitAiConfig,
  CommitAiProvider,
  CommitGenerationMode,
  CommitLanguageMode,
  CommitSkillOption,
} from '../../../types/aiFeatureConfig';
import {
  DEFAULT_COMMIT_AI_CONFIG,
  DEFAULT_COMMIT_SKILL_REF,
} from '../../../types/aiFeatureConfig';
import AiFeatureProviderModelPanel from '../AiFeatureProviderModelPanel';
import AiFeatureSettingsCard from '../AiFeatureSettingsCard';

interface CommitSectionProps {
  commitAiConfig?: CommitAiConfig;
  onCommitAiProviderChange?: (provider: CommitAiProvider) => void;
  onCommitAiModelChange?: (model: string) => void;
  onCommitGenerationModeChange?: (mode: CommitGenerationMode) => void;
  onCommitSkillChange?: (skillRef: string) => void;
  onCommitLanguageChange?: (language: CommitLanguageMode) => void;
  onCommitAiResetToDefault?: () => void;
  commitPrompt: string;
  projectCommitPrompt: string;
  onCommitPromptChange: (prompt: string) => void;
  onProjectCommitPromptChange: (prompt: string) => void;
  onSaveCommitPrompt: () => void;
  onSaveProjectCommitPrompt: () => void;
  savingCommitPrompt: boolean;
  savingProjectCommitPrompt: boolean;
}

const CommitSection = ({
  commitAiConfig = DEFAULT_COMMIT_AI_CONFIG,
  onCommitAiProviderChange = () => {},
  onCommitAiModelChange = () => {},
  onCommitGenerationModeChange = () => {},
  onCommitSkillChange = () => {},
  onCommitLanguageChange = () => {},
  onCommitAiResetToDefault = () => {},
  commitPrompt,
  projectCommitPrompt,
  onCommitPromptChange,
  onProjectCommitPromptChange,
  onSaveCommitPrompt,
  onSaveProjectCommitPrompt,
  savingCommitPrompt,
  savingProjectCommitPrompt,
}: CommitSectionProps) => {
  const { t } = useTranslation();
  const generationMode = commitAiConfig.generationMode ?? 'prompt';
  const language = commitAiConfig.language ?? 'auto';
  const availableSkills = useMemo(() => {
    const skills = [...(commitAiConfig.availableSkills ?? [])];
    if (!skills.some((skill) => skill.ref === DEFAULT_COMMIT_SKILL_REF)) {
      skills.unshift(createBuiltinSkillOption(t));
    }
    if (
      generationMode === 'skill'
      && commitAiConfig.skillRef
      && !skills.some((skill) => skill.ref === commitAiConfig.skillRef)
    ) {
      skills.unshift({
        ref: commitAiConfig.skillRef,
        name: commitAiConfig.skillRef,
        description: t('settings.commit.skill.missingDescription', {
          defaultValue: 'Selected skill is no longer available.',
        }),
        source: 'local',
        scope: 'custom',
        enabled: false,
        builtin: false,
      });
    }
    return skills;
  }, [commitAiConfig.availableSkills, commitAiConfig.skillRef, generationMode, t]);
  const selectedSkillRef = commitAiConfig.skillRef?.trim() || DEFAULT_COMMIT_SKILL_REF;

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

      <div className={styles.modeSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-symbol-method" />
          <span className={styles.fieldLabel}>{t('settings.commit.generationMode.label')}</span>
        </div>
        <div className={styles.modeRow}>
          <div className={styles.inlineField}>
            <span className={styles.inlineLabel}>{t('settings.commit.generationMode.modeLabel', { defaultValue: t('settings.commit.generationMode.label') })}</span>
            <div className={styles.selectWrap}>
              <select
                className={styles.modeSelect}
                value={generationMode}
                onChange={(e) => onCommitGenerationModeChange(e.target.value as CommitGenerationMode)}
                aria-label={t('settings.commit.generationMode.label')}
              >
                <option value="prompt">{t('settings.commit.generationMode.prompt')}</option>
                <option value="skill">{t('settings.commit.generationMode.skill')}</option>
              </select>
              <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
            </div>
          </div>
          <div className={styles.inlineField}>
            <span className={styles.inlineLabel}>{t('settings.commit.language.label', { defaultValue: 'Commit Language' })}</span>
            <div className={styles.selectWrap}>
              <select
                className={styles.modeSelect}
                value={language}
                onChange={(e) => onCommitLanguageChange(e.target.value as CommitLanguageMode)}
                aria-label={t('settings.commit.language.label')}
              >
                {COMMIT_LANGUAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {t(option.labelKey, { defaultValue: option.defaultLabel })}
                  </option>
                ))}
              </select>
              <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
            </div>
          </div>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.commit.generationMode.hint')}</span>
        </small>
      </div>

      {generationMode === 'skill' && (
        <div className={styles.skillSection}>
          <div className={styles.fieldHeader}>
            <span className="codicon codicon-bookmark" />
            <span className={styles.fieldLabel}>{t('settings.commit.skill.label')}</span>
          </div>
          <div className={styles.skillRow}>
            <div className={styles.selectWrap}>
              <select
                className={styles.skillSelect}
                value={selectedSkillRef}
                onChange={(e) => onCommitSkillChange(e.target.value)}
                aria-label={t('settings.commit.skill.label')}
              >
                {availableSkills.map((skill) => (
                  <option key={skill.ref} value={skill.ref}>
                    {formatSkillLabel(skill, t)}
                  </option>
                ))}
              </select>
              <span className={`codicon codicon-chevron-down ${styles.selectArrow}`} />
            </div>
          </div>
          <small className={styles.formHint}>
            <span className="codicon codicon-info" />
            <span>{t('settings.commit.skill.hint')}</span>
          </small>
        </div>
      )}

      {generationMode === 'prompt' && (
        <>
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

          {/* Project-level commit prompt configuration */}
          <div className={styles.promptSection}>
            <div className={styles.fieldHeader}>
              <span className="codicon codicon-folder" />
              <span className={styles.fieldLabel}>{t('settings.commit.projectPrompt.label')}</span>
            </div>
            <div className={styles.promptInputWrapper}>
              <textarea
                className={styles.promptTextarea}
                placeholder={t('settings.commit.projectPrompt.placeholder')}
                value={projectCommitPrompt}
                onChange={(e) => onProjectCommitPromptChange(e.target.value)}
                rows={6}
              />
              <button
                className={styles.saveBtn}
                onClick={onSaveProjectCommitPrompt}
                disabled={savingProjectCommitPrompt}
              >
                {savingProjectCommitPrompt && (
                  <span className="codicon codicon-loading codicon-modifier-spin" />
                )}
                {t('common.save')}
              </button>
            </div>
            <small className={styles.formHint}>
              <span className="codicon codicon-info" />
              <span>{t('settings.commit.projectPrompt.hint')}</span>
            </small>
          </div>
        </>
      )}
    </div>
  );
};

export default CommitSection;

const COMMIT_LANGUAGE_OPTIONS: Array<{
  value: CommitLanguageMode;
  labelKey: string;
  defaultLabel: string;
}> = [
  { value: 'auto', labelKey: 'settings.commit.language.auto', defaultLabel: 'Follow UI language' },
  { value: 'en', labelKey: 'settings.basic.language.english', defaultLabel: 'English' },
  { value: 'zh', labelKey: 'settings.basic.language.simplifiedChinese', defaultLabel: '简体中文' },
  { value: 'zh-TW', labelKey: 'settings.basic.language.traditionalChinese', defaultLabel: '繁體中文' },
  { value: 'ko', labelKey: 'settings.basic.language.korean', defaultLabel: '한국어' },
  { value: 'ja', labelKey: 'settings.basic.language.japanese', defaultLabel: '日本語' },
  { value: 'es', labelKey: 'settings.basic.language.spanish', defaultLabel: 'Español' },
  { value: 'fr', labelKey: 'settings.basic.language.french', defaultLabel: 'Français' },
  { value: 'hi', labelKey: 'settings.basic.language.hindi', defaultLabel: 'हिन्दी' },
  { value: 'ru', labelKey: 'settings.basic.language.russian', defaultLabel: 'Русский' },
  { value: 'pt-BR', labelKey: 'settings.basic.language.portuguese', defaultLabel: 'Português (Brasil)' },
];

function createBuiltinSkillOption(t: any): CommitSkillOption {
  return {
    ref: DEFAULT_COMMIT_SKILL_REF,
    name: 'git-commit',
    description: t('settings.commit.skill.builtinDescription'),
    source: 'builtin',
    scope: 'builtin',
    enabled: true,
    builtin: true,
  };
}

function formatSkillLabel(
  skill: CommitSkillOption,
  t: any,
) {
  if (skill.builtin || skill.ref === DEFAULT_COMMIT_SKILL_REF) {
    return t('settings.commit.skill.builtinLabel');
  }
  const scope = skill.scope ? ` · ${skill.scope}` : '';
  return `${skill.name}${scope}`;
}
