import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PET_ACTIONS,
  PET_VISUAL_STATES,
  type CodexPetAction,
  type CodexPetConfig,
  type CodexPetVisualState,
  type LocalCodexPet,
} from '../../codexPet/petBridge';
import { ACTION_PREVIEW_METADATA, LocalPetPreview } from './previews';
import styles from './style.module.less';

interface ActionsTabProps {
  config: CodexPetConfig;
  updateConfig: (patch: Partial<CodexPetConfig>) => void;
  currentPet: LocalCodexPet | undefined;
}

export default function ActionsTab({ config, updateConfig, currentPet }: ActionsTabProps) {
  const { t } = useTranslation();
  const [selectedActionState, setSelectedActionState] = useState<CodexPetVisualState>('idle');
  const [previewAction, setPreviewAction] = useState<CodexPetAction>('idle');
  const [previewFrame, setPreviewFrame] = useState(0);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewMetadata = ACTION_PREVIEW_METADATA[previewAction];

  const selectPreviewAction = useCallback((action: CodexPetAction) => {
    setPreviewAction(action);
    setPreviewFrame(0);
    setPreviewPlaying(false);
  }, []);

  useEffect(() => {
    if (!previewPlaying) return undefined;
    const timer = window.setInterval(() => {
      setPreviewFrame((current) => (current + 1) % previewMetadata.frameCount);
    }, 140);
    return () => window.clearInterval(timer);
  }, [previewMetadata.frameCount, previewPlaying]);

  return (
    <section className={styles.controlSection}>
      <div className={styles.sectionHeader}>
        <div>
          <h4>{t('settings.pet.actionsTitle')}</h4>
          <p>{t('settings.pet.actionsDescription')}</p>
        </div>
      </div>
      <div className={styles.actionConfigurationBar}>
        <div className={styles.actionStateTabs} role="tablist" aria-label={t('settings.pet.actionStateLabel')}>
          {PET_VISUAL_STATES.map((state) => {
            const selected = state === selectedActionState;
            return (
              <button
                key={state}
                type="button"
                role="tab"
                aria-selected={selected}
                className={selected ? styles.actionStateTabActive : styles.actionStateTab}
                onClick={() => setSelectedActionState(state)}
              >
                <span>{t(`settings.pet.visualStates.${state}`)}</span>
                <em>{config.actionMappings[state].length}</em>
              </button>
            );
          })}
        </div>
      </div>
      <div className={styles.actionWorkspace}>
        <section className={styles.actionEditor}>
          <header className={styles.actionEditorHeader}>
            <div>
              <h5>{t('settings.pet.actionMappingTitle')}</h5>
              <p>{t('settings.pet.actionsDescription')}</p>
            </div>
            <span>{t('settings.pet.actionSelectedCount', {
              count: config.actionMappings[selectedActionState].length,
            })}</span>
          </header>
          <div className={styles.actionOptionGrid} role="group" aria-label={t(`settings.pet.visualStates.${selectedActionState}`)}>
            {PET_ACTIONS.map((action) => {
              const selectedActions = config.actionMappings[selectedActionState];
              const checked = selectedActions.includes(action);
              return (
                <label
                  key={action}
                  className={checked ? styles.actionOptionSelected : styles.actionOption}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const nextActions = checked
                        ? selectedActions.filter((item) => item !== action)
                        : [...selectedActions, action];
                      if (nextActions.length === 0) {
                        event.currentTarget.checked = true;
                        return;
                      }
                      updateConfig({
                        actionMappings: {
                          ...config.actionMappings,
                          [selectedActionState]: [...new Set(nextActions)],
                        },
                      });
                    }}
                  />
                  <span>
                    <strong>{t(`settings.pet.actions.${action}`)}</strong>
                    <small>{t(`settings.pet.actionDescriptions.${action}`)}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
        <aside className={styles.actionPreview}>
          <div className={styles.actionPreviewHeader}>
            <div>
              <h4>{t('settings.pet.actionPreview')}</h4>
              <p>{t('settings.pet.actionPreviewHint')}</p>
            </div>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setPreviewPlaying((current) => !current)}
              title={t(previewPlaying ? 'settings.pet.pausePreview' : 'settings.pet.playPreview')}
              aria-label={t(previewPlaying ? 'settings.pet.pausePreview' : 'settings.pet.playPreview')}
            >
              <span className={`codicon ${previewPlaying ? 'codicon-debug-pause' : 'codicon-play'}`} aria-hidden="true" />
            </button>
          </div>
          <label className={styles.field}>
            <span>{t('settings.pet.previewAction')}</span>
            <select
              value={previewAction}
              onChange={(event) => selectPreviewAction(event.target.value as CodexPetAction)}
            >
              {PET_ACTIONS.map((action) => (
                <option key={action} value={action}>{t(`settings.pet.actions.${action}`)}</option>
              ))}
            </select>
          </label>
          <div className={styles.actionPreviewStage}>
            {currentPet ? (
              <LocalPetPreview
                pet={currentPet}
                action={previewAction}
                frame={previewFrame}
                animate={false}
              />
            ) : (
              <span className={`codicon codicon-hubot ${styles.builtinPreview}`} aria-hidden="true" />
            )}
          </div>
          <label className={styles.previewTimeline}>
            <span>{t('settings.pet.previewFrame')}</span>
            <input
              type="range"
              min="0"
              max={previewMetadata.frameCount - 1}
              step="1"
              value={previewFrame}
              onChange={(event) => {
                setPreviewPlaying(false);
                setPreviewFrame(Number(event.target.value));
              }}
            />
            <strong>{String(previewFrame + 1).padStart(2, '0')} / {String(previewMetadata.frameCount).padStart(2, '0')}</strong>
          </label>
          <p className={styles.actionPreviewCaption}>
            {currentPet?.spriteSheet
              ? t('settings.pet.actionPreviewSpriteHint')
              : t('settings.pet.actionPreviewStaticHint')}
          </p>
        </aside>
      </div>
      <p className={styles.actionMappingHint}>{t('settings.pet.actionsHint')}</p>
    </section>
  );
}
