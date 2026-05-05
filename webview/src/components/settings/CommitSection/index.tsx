import styles from './style.module.less';
import { useTranslation } from 'react-i18next';

interface CommitSectionProps {
  commitPrompt: string;
  onCommitPromptChange: (prompt: string) => void;
  onSaveCommitPrompt: () => void;
  savingCommitPrompt: boolean;
  commitGenerationEnabled: boolean;
  onCommitGenerationEnabledChange: (enabled: boolean) => void;
}

const CommitSection = ({
  commitPrompt,
  onCommitPromptChange,
  onSaveCommitPrompt,
  savingCommitPrompt,
  commitGenerationEnabled,
  onCommitGenerationEnabledChange,
}: CommitSectionProps) => {
  const { t } = useTranslation();

  return (
    <div className={styles.configSection}>
      <h3 className={styles.sectionTitle}>{t('settings.commit.title')}</h3>
      <p className={styles.sectionDesc}>{t('settings.commit.description')}</p>

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

      <div className={styles.autoCommitSection}>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-git-commit" />
          <span className={styles.fieldLabel}>{t('settings.basic.commitGeneration.label')}</span>
        </div>
        <label className={styles.toggleWrapper}>
          <input
            type="checkbox"
            className={styles.toggleInput}
            checked={commitGenerationEnabled}
            onChange={(e) => onCommitGenerationEnabledChange(e.target.checked)}
          />
          <span className={styles.toggleSlider} />
          <span className={styles.toggleLabel}>
            {commitGenerationEnabled
              ? t('settings.basic.commitGeneration.enabled')
              : t('settings.basic.commitGeneration.disabled')}
          </span>
        </label>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.basic.commitGeneration.hint')}</span>
        </small>
      </div>

      {/* Code Review AI preview */}
      <div className={styles.previewSection}>
        <div className={styles.previewBadge}>
          <span className="codicon codicon-sparkle" />
          <span>{t('settings.commit.codeReview.comingSoon')}</span>
        </div>
        <div className={styles.fieldHeader}>
          <span className="codicon codicon-code" />
          <span className={styles.fieldLabel}>{t('settings.commit.codeReview.label')}</span>
        </div>
        <div className={styles.promptInputWrapper}>
          <textarea
            className={`${styles.promptTextarea} ${styles.disabled}`}
            placeholder={t('settings.commit.codeReview.placeholder')}
            disabled
            rows={4}
          />
          <button
            className={`${styles.saveBtn} ${styles.disabledBtn}`}
            disabled
          >
            {t('common.save')}
          </button>
        </div>
        <small className={styles.formHint}>
          <span className="codicon codicon-info" />
          <span>{t('settings.commit.codeReview.hint')}</span>
        </small>
      </div>
    </div>
  );
};

export default CommitSection;
