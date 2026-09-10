import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BUBBLE_EVENTS,
  DEFAULT_BUBBLE_TEMPLATES,
  type CodexPetBubbleEvent,
  type CodexPetBubbleSize,
  type CodexPetConfig,
} from '../../codexPet/petBridge';
import { parseNumericInput } from './utils';
import styles from './style.module.less';

const BUBBLE_SIZE_OPTIONS: CodexPetBubbleSize[] = ['small', 'medium', 'large', 'xlarge'];

interface BubbleTabProps {
  config: CodexPetConfig;
  updateConfig: (patch: Partial<CodexPetConfig>) => void;
  updateConfigDraft: (patch: Partial<CodexPetConfig>) => void;
}

export default function BubbleTab({ config, updateConfig, updateConfigDraft }: BubbleTabProps) {
  const { t } = useTranslation();
  const parseTemplateLines = useCallback((value: string): string[] => value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10), []);
  const updateBubbleTemplates = useCallback((
    event: CodexPetBubbleEvent,
    value: string,
    persist: boolean,
  ) => {
    const templates = {
      ...config.bubbleTemplates,
      [event]: parseTemplateLines(value),
    };
    if (persist) {
      updateConfig({ bubbleTemplates: templates });
    } else {
      updateConfigDraft({ bubbleTemplates: templates });
    }
  }, [config.bubbleTemplates, parseTemplateLines, updateConfig, updateConfigDraft]);

  return (
    <section className={styles.controlSection}>
      <div className={styles.sectionHeader}>
        <div className={styles.bubbleHeaderContent}>
          <h4>{t('settings.pet.bubbleTitle')}</h4>
          <p>{t('settings.pet.bubbleDescription')}</p>
          <div className={styles.bubbleActions} data-testid="pet-bubble-actions">
            <label className={styles.switchLabel}>
              <input
                type="checkbox"
                checked={config.bubbleEnabled}
                onChange={(event) => updateConfig({ bubbleEnabled: event.target.checked })}
              />
              <span>{config.bubbleEnabled ? t('settings.pet.enabled') : t('settings.pet.disabled')}</span>
            </label>
            <label className={styles.switchLabel}>
              <input
                type="checkbox"
                checked={config.bubbleShowForBackgroundTabs}
                onChange={(event) => updateConfig({ bubbleShowForBackgroundTabs: event.target.checked })}
              />
              <span>{t('settings.pet.bubbleShowForBackgroundTabs')}</span>
            </label>
          </div>
        </div>
      </div>

      <div className={styles.bubbleSettings}>
        <label className={styles.field}>
          <span>{t('settings.pet.bubbleDuration')}</span>
          <input
            type="number"
            min="1"
            max="20"
            value={config.bubbleDurationSeconds}
            onChange={(event) => updateConfigDraft({
              bubbleDurationSeconds: parseNumericInput(event.target.value, config.bubbleDurationSeconds),
            })}
            onBlur={(event) => updateConfig({
              bubbleDurationSeconds: parseNumericInput(event.currentTarget.value, config.bubbleDurationSeconds),
            })}
          />
        </label>
        <label className={styles.field}>
          <span>{t('settings.pet.bubbleSize')}</span>
          <select
            value={config.bubbleSize}
            onChange={(event) => updateConfig({ bubbleSize: event.target.value as CodexPetBubbleSize })}
          >
            {BUBBLE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {t(`settings.pet.bubbleSizes.${size}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className={styles.placeholderHint}>
        <span className={styles.placeholderTitle}>{t('settings.pet.templateVariables')}</span>
        <div className={styles.placeholderTableWrap}>
          <table className={styles.placeholderTable}>
            <thead>
              <tr>
                <th>{t('settings.pet.templateVariableTable.variable')}</th>
                <th>{t('settings.pet.templateVariableTable.content')}</th>
              </tr>
            </thead>
            <tbody>
              {(['tabTitle', 'provider', 'model', 'duration'] as const).map((variable) => (
                <tr key={variable}>
                  <td><code>{`{${variable}}`}</code></td>
                  <td>{t(`settings.pet.templateVariableTable.${variable}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.templateGrid}>
        {BUBBLE_EVENTS.map((event) => (
          <label key={event} className={styles.templateField}>
            <span>{t(`settings.pet.bubbleEvents.${event}`)}</span>
            <textarea
              rows={3}
              value={(config.bubbleTemplates[event] ?? DEFAULT_BUBBLE_TEMPLATES[event]).join('\n')}
              onChange={(changeEvent) => updateBubbleTemplates(event, changeEvent.target.value, false)}
              onBlur={(blurEvent) => updateBubbleTemplates(event, blurEvent.currentTarget.value, true)}
            />
          </label>
        ))}
      </div>
    </section>
  );
}
