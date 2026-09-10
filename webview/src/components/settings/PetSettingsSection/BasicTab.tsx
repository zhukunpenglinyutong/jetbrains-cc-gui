import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  petBridge,
  type CodexPetConfig,
  type LocalCodexPet,
} from '../../codexPet/petBridge';
import { LocalPetPreview } from './previews';
import SearchablePetSelect, { type PetSelectOption } from './SearchablePetSelect';
import type { PendingPetOperation } from './types';
import { normalizeAliasDraft } from './utils';
import styles from './style.module.less';

interface BasicTabProps {
  config: CodexPetConfig;
  updateConfig: (patch: Partial<CodexPetConfig>) => void;
  currentPet: LocalCodexPet | undefined;
  localPets: LocalCodexPet[];
  pendingPetOperation: PendingPetOperation | null;
  saveAlias: (alias: string) => void;
  deleteCurrentPet: () => void;
  refreshPetAssets: () => void;
}

export default function BasicTab({
  config,
  updateConfig,
  currentPet,
  localPets,
  pendingPetOperation,
  saveAlias,
  deleteCurrentPet,
  refreshPetAssets,
}: BasicTabProps) {
  const { t } = useTranslation();
  const [aliasDraft, setAliasDraft] = useState('');
  useEffect(() => {
    setAliasDraft(currentPet?.alias ?? '');
  }, [currentPet?.alias, currentPet?.id]);
  const petOptions = useMemo<PetSelectOption[]>(() => {
    const options: PetSelectOption[] = [{
      value: 'builtin',
      label: 'Codex',
      detail: 'builtin',
      searchText: 'codex builtin',
    }];
    for (const pet of localPets) {
      const originalName = pet.originalName ?? pet.name;
      options.push({
        value: pet.id,
        label: pet.name,
        detail: pet.id,
        searchText: `${pet.name} ${originalName} ${pet.alias ?? ''} ${pet.id}`.toLocaleLowerCase(),
      });
    }
    if (config.selectedPetId !== 'builtin' && !localPets.some((pet) => pet.id === config.selectedPetId)) {
      options.push({
        value: config.selectedPetId,
        label: config.selectedPetId.split('/')[0],
        detail: config.selectedPetId,
        searchText: config.selectedPetId.toLocaleLowerCase(),
      });
    }
    return options;
  }, [config.selectedPetId, localPets]);
  return (
    <div className={styles.basicLayout}>
      <section className={styles.previewPanel} aria-label={t('settings.pet.preview')}>
        <div className={styles.previewPanelHeader}>
          <span>{t('settings.pet.preview')}</span>
          <label className={`${styles.switchLabel} ${styles.previewEnabledToggle}`}>
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => updateConfig({ enabled: event.target.checked })}
            />
            <span>{config.enabled ? t('settings.pet.enabled') : t('settings.pet.disabled')}</span>
          </label>
        </div>
        <div className={styles.previewStage}>
          {currentPet ? (
            <LocalPetPreview pet={currentPet} />
          ) : (
            <span className={`codicon codicon-hubot ${styles.builtinPreview}`} aria-hidden="true" />
          )}
        </div>
        <div className={styles.previewPanelFooter}>
          <span>{t('settings.pet.scopePositionHint')}</span>
          <button type="button" className={styles.secondaryButton} onClick={petBridge.resetPosition}>
            <span className="codicon codicon-target" aria-hidden="true" />
            {t('settings.pet.resetPosition')}
          </button>
        </div>
      </section>

      <section className={styles.operationsPanel}>
        <header className={styles.operationsHeader}>
          <h4>{t('settings.pet.displayAndOperations')}</h4>
          <div className={styles.operationsActions}>
            <button type="button" className={styles.secondaryButton} onClick={refreshPetAssets}>
              <span className="codicon codicon-refresh" aria-hidden="true" />
              {t('settings.pet.refreshAssets')}
            </button>
            {currentPet && (
              <button
                type="button"
                className={styles.dangerButton}
                onClick={deleteCurrentPet}
                disabled={pendingPetOperation !== null}
              >
                <span className="codicon codicon-trash" aria-hidden="true" />
                {pendingPetOperation?.operation === 'delete'
                  && pendingPetOperation.target === currentPet.id
                  ? t('settings.pet.processing')
                  : t('settings.pet.delete')}
              </button>
            )}
          </div>
        </header>
        <div className={styles.operationsBody}>
          <div className={styles.operationRow} data-testid="pet-basic-actions">
            <div>
              <span className={styles.operationLabel}>{t('settings.pet.currentPet')}</span>
              <p>{t('settings.pet.currentPetHint')}</p>
            </div>
            <SearchablePetSelect
              value={config.selectedPetId}
              options={petOptions}
              ariaLabel={t('settings.pet.currentPet')}
              searchPlaceholder={t('settings.pet.petSearchPlaceholder')}
              emptyLabel={t('settings.pet.noMatchingLocalPets')}
              onChange={(selectedPetId) => updateConfig({ selectedPetId })}
            />
          </div>

          <div className={styles.operationRow}>
            <div>
              <span className={styles.operationLabel}>{t('settings.pet.showStatusIndicator')}</span>
              <p>{t('settings.pet.showStatusIndicatorHint')}</p>
            </div>
            <label className={styles.switchLabel}>
              <input
                type="checkbox"
                checked={config.showStatusIndicator}
                onChange={(event) => updateConfig({ showStatusIndicator: event.target.checked })}
              />
              <span>{t('settings.pet.showStatusIndicator')}</span>
            </label>
          </div>

          <div className={styles.operationRow}>
            <div>
              <span className={styles.operationLabel}>{t('settings.pet.confirmBeforeDelete')}</span>
              <p>{t('settings.pet.confirmBeforeDeleteHint')}</p>
            </div>
            <label className={styles.switchLabel}>
              <input
                type="checkbox"
                checked={config.confirmBeforeDelete}
                onChange={(event) => updateConfig({ confirmBeforeDelete: event.target.checked })}
              />
              <span>{t('settings.pet.confirmBeforeDelete')}</span>
            </label>
          </div>

          {currentPet?.managed && currentPet.slug && (
            <div className={styles.operationRow}>
              <div>
                <span className={styles.operationLabel}>{t('settings.pet.alias')}</span>
                <p>{t('settings.pet.aliasDescription')}</p>
              </div>
              <div className={styles.aliasEditor}>
                <label className={styles.visuallyHidden} htmlFor="codex-pet-alias">
                  {t('settings.pet.alias')}
                </label>
                <input
                  id="codex-pet-alias"
                  type="text"
                  value={aliasDraft}
                  maxLength={60}
                  placeholder={t('settings.pet.aliasPlaceholder', {
                    name: currentPet.originalName ?? currentPet.name,
                  })}
                  onChange={(event) => setAliasDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      saveAlias(aliasDraft);
                    }
                  }}
                />
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => saveAlias(aliasDraft)}
                  disabled={pendingPetOperation !== null
                    || normalizeAliasDraft(aliasDraft) === (currentPet.alias ?? '')}
                >
                  <span className="codicon codicon-save" aria-hidden="true" />
                  {t('settings.pet.saveAlias')}
                </button>
              </div>
            </div>
          )}

          <label className={`${styles.operationRow} ${styles.operationRangeRow}`}>
            <span>
              <span className={styles.operationLabel}>{t('settings.pet.size')}</span>
              <p>{t('settings.pet.sizeHint')}</p>
            </span>
            <span className={styles.rangeControl}>
              <input
                type="range"
                min="32"
                max="512"
                step="4"
                value={config.size}
                onChange={(event) => updateConfig({ size: Number(event.target.value) })}
              />
              <strong>{config.size}px</strong>
            </span>
          </label>

          <label className={`${styles.operationRow} ${styles.operationRangeRow}`}>
            <span>
              <span className={styles.operationLabel}>{t('settings.pet.opacity')}</span>
              <p>{t('settings.pet.opacityHint')}</p>
            </span>
            <span className={styles.rangeControl}>
              <input
                type="range"
                min="0.3"
                max="1"
                step="0.05"
                value={config.opacity}
                onChange={(event) => updateConfig({ opacity: Number(event.target.value) })}
              />
              <strong>{Math.round(config.opacity * 100)}%</strong>
            </span>
          </label>
        </div>
      </section>
    </div>
  );
}
