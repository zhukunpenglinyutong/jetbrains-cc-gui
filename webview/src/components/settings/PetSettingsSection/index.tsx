import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  petBridge,
  DEFAULT_ACTION_MAPPINGS,
  DEFAULT_BUBBLE_TEMPLATES,
  type CodexPetConfig,
  type CodexPetScope,
  type HatchPetStatus,
  type LocalCodexPet,
} from '../../codexPet/petBridge';
import { useUIState } from '../../../contexts/UIStateContext';
import ActionsTab from './ActionsTab';
import BasicTab from './BasicTab';
import BubbleTab from './BubbleTab';
import LocalPetTab from './LocalPetTab';
import PetConfirmationDialog from './PetConfirmationDialog';
import PetDexTab from './PetDexTab';
import { useCatalog } from './useCatalog';
import type {
  HatchPetAction,
  PendingPetOperation,
  PetConfirmation,
  PetSettingsTab,
} from './types';
import { normalizeAliasDraft, petErrorDescriptor } from './utils';
import styles from './style.module.less';

interface PetSettingsSectionProps {
  addToast: (message: string, type?: 'success' | 'error' | 'warning' | 'info') => void;
}

const DEFAULT_CONFIG: CodexPetConfig = {
  enabled: false,
  selectedPetId: 'builtin',
  size: 96,
  opacity: 1,
  positionX: 0.88,
  positionY: 0.78,
  petdexConnectTimeoutSeconds: 30,
  petdexRequestTimeoutSeconds: 60,
  petdexRetryAttempts: 3,
  catalogColumns: 4,
  catalogPageSize: 12,
  catalogSort: 'default',
  showStatusIndicator: false,
  confirmBeforeDelete: true,
  actionMappings: DEFAULT_ACTION_MAPPINGS,
  bubbleEnabled: true,
  bubbleDurationSeconds: 4,
  bubbleSize: 'medium',
  bubbleShowForBackgroundTabs: false,
  bubbleTemplates: DEFAULT_BUBBLE_TEMPLATES,
  scope: 'project',
};
const SCOPE_OPTIONS: CodexPetScope[] = ['project', 'global'];
const PET_TABS: Array<{ key: PetSettingsTab; labelKey: string; icon: string }> = [
  { key: 'basic', labelKey: 'settings.pet.tabs.basic', icon: 'codicon-hubot' },
  { key: 'actions', labelKey: 'settings.pet.tabs.actions', icon: 'codicon-run-all' },
  { key: 'bubble', labelKey: 'settings.pet.tabs.bubble', icon: 'codicon-comment-discussion' },
  { key: 'local', labelKey: 'settings.pet.tabs.local', icon: 'codicon-folder-opened' },
  { key: 'petdex', labelKey: 'settings.pet.tabs.petdex', icon: 'codicon-globe' },
];

export default function PetSettingsSection({ addToast }: PetSettingsSectionProps) {
  const { t } = useTranslation();
  const { draftInput, setDraftInput, setCurrentView } = useUIState();
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [activeTab, setActiveTab] = useState<PetSettingsTab>('basic');
  const [localPets, setLocalPets] = useState<LocalCodexPet[]>([]);
  const [pendingPetOperation, setPendingPetOperation] = useState<PendingPetOperation | null>(null);
  const [confirmation, setConfirmation] = useState<PetConfirmation>(null);
  const [hatchStatus, setHatchStatus] = useState<HatchPetStatus | null>(null);
  const [hatchName, setHatchName] = useState('');
  const [hatchDescription, setHatchDescription] = useState('');
  const [hatchStyle, setHatchStyle] = useState('auto');
  const [hatchReference, setHatchReference] = useState('');
  const catalogState = useCatalog(config.catalogPageSize, config.catalogSort);
  const { reloadAfterOperation } = catalogState;

  useEffect(() => {
    const unsubscribeConfig = petBridge.subscribeConfig(setConfig);
    const unsubscribeLocal = petBridge.subscribeLocalPets(setLocalPets);
    const unsubscribeOperation = petBridge.subscribeOperation((operation) => {
      const operationTarget = operation.operation === 'delete'
        ? operation.petId
        : operation.slug;
      setPendingPetOperation((pending) => pending
        && pending.operation === operation.operation
        && pending.target === operationTarget
        ? null
        : pending);
      if (operation.success) {
        const successKey = operation.operation === 'install'
          ? 'settings.pet.installSuccess'
          : operation.operation === 'uninstall'
            ? 'settings.pet.uninstallSuccess'
            : operation.operation === 'delete'
              ? 'settings.pet.deleteSuccess'
            : operation.operation === 'alias'
              ? 'settings.pet.aliasSuccess'
              : null;
        if (successKey) {
          addToast(t(successKey), 'success');
        }
        if (['install', 'uninstall', 'delete', 'alias'].includes(operation.operation)) {
          reloadAfterOperation(operation.operation !== 'alias');
        }
      } else {
        const error = operation.error ?? 'UNKNOWN';
        const descriptor = petErrorDescriptor(error);
        addToast(t('settings.pet.operationFailed', {
          error: t(descriptor.key, descriptor.params),
        }), 'error');
      }
    });
    const unsubscribeHatchStatus = petBridge.subscribeHatchStatus(setHatchStatus);
    const unsubscribeHatchReference = petBridge.subscribeHatchReference(setHatchReference);
    const unsubscribeHatchCommand = petBridge.subscribeHatchCommand((command) => {
      setDraftInput(command);
      addToast(t('settings.pet.hatchCommandPrepared'), 'success');
      setCurrentView('chat');
    });
    petBridge.getConfig();
    petBridge.getLocalPets();
    petBridge.getHatchStatus();
    return () => {
      unsubscribeConfig();
      unsubscribeLocal();
      unsubscribeOperation();
      unsubscribeHatchStatus();
      unsubscribeHatchReference();
      unsubscribeHatchCommand();
    };
  }, [addToast, reloadAfterOperation, setCurrentView, setDraftInput, t]);

  const updateConfig = useCallback((patch: Partial<CodexPetConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
    petBridge.setConfig(patch);
  }, []);
  const updateConfigDraft = useCallback((patch: Partial<CodexPetConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
  }, []);

  const currentPet = localPets.find((pet) => pet.id === config.selectedPetId);

  const installPet = useCallback((slug: string) => {
    setPendingPetOperation({ operation: 'install', target: slug });
    petBridge.install(slug);
  }, []);

  const startUninstall = useCallback((slug: string) => {
    setPendingPetOperation({ operation: 'uninstall', target: slug });
    petBridge.uninstall(slug);
  }, []);

  const startDelete = useCallback((petId: string) => {
    setPendingPetOperation({ operation: 'delete', target: petId });
    petBridge.deleteLocalPet(petId);
  }, []);

  const uninstallPet = useCallback((slug: string, name: string) => {
    if (config.confirmBeforeDelete) {
      setConfirmation({ kind: 'uninstall', slug, name });
      return;
    }
    startUninstall(slug);
  }, [config.confirmBeforeDelete, startUninstall]);

  const deleteCurrentPet = useCallback(() => {
    if (!currentPet) return;
    if (config.confirmBeforeDelete) {
      setConfirmation({ kind: 'delete', petId: currentPet.id, name: currentPet.name });
      return;
    }
    startDelete(currentPet.id);
  }, [config.confirmBeforeDelete, currentPet, startDelete]);

  const refreshPetAssets = useCallback(() => {
    petBridge.refreshAssets();
    petBridge.getLocalPets();
  }, []);

  const saveAlias = useCallback((alias: string) => {
    const normalizedAlias = normalizeAliasDraft(alias);
    if (!currentPet?.managed
      || !currentPet.slug
      || pendingPetOperation !== null
      || normalizedAlias === (currentPet.alias ?? '')) return;
    setPendingPetOperation({ operation: 'alias', target: currentPet.slug });
    petBridge.setAlias(currentPet.slug, normalizedAlias);
  }, [currentPet, pendingPetOperation]);

  const startHatchCommand = useCallback((action: HatchPetAction) => {
    petBridge.prepareHatchCommand({
      action,
      name: hatchName,
      description: hatchDescription,
      style: hatchStyle,
      referencePath: hatchReference,
    });
  }, [hatchDescription, hatchName, hatchReference, hatchStyle]);

  const prepareHatchCommand = useCallback((action: HatchPetAction) => {
    if (draftInput.trim()) {
      setConfirmation({ kind: 'replace-draft', action });
      return;
    }
    startHatchCommand(action);
  }, [draftInput, startHatchCommand]);

  const closeConfirmation = useCallback(() => setConfirmation(null), []);
  const confirmOperation = useCallback(() => {
    if (!confirmation) return;
    closeConfirmation();
    if (confirmation.kind === 'delete') {
      startDelete(confirmation.petId);
    } else if (confirmation.kind === 'uninstall') {
      startUninstall(confirmation.slug);
    } else {
      startHatchCommand(confirmation.action);
    }
  }, [closeConfirmation, confirmation, startDelete, startHatchCommand, startUninstall]);

  return (
    <div className={styles.section}>
      <h3 className={styles.title}>{t('settings.pet.title')}</h3>
      <p className={styles.description}>{t('settings.pet.description')}</p>

      <div className={styles.scopeBar} role="group" aria-label={t('settings.pet.scopeLabel')}>
        <div className={styles.scopeCopy} aria-live="polite">
          <span className={styles.scopeTitle}>{t('settings.pet.scopeLabel')}</span>
          <p className={styles.scopeDescription}>
            {t(`settings.pet.scopeDescriptions.${config.scope}`)}
          </p>
        </div>
        <div className={styles.segmentedControl}>
          {SCOPE_OPTIONS.map((scope) => (
            <button
              key={scope}
              type="button"
              className={config.scope === scope ? styles.segmentActive : styles.segment}
              aria-pressed={config.scope === scope}
              onClick={() => updateConfig({ scope })}
            >
              {t(`settings.pet.scopeOptions.${scope}`)}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.tabbedGroup}>
        <div className={styles.sectionTabs} role="tablist" aria-label={t('settings.pet.title')}>
          {PET_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`pet-tab-${tab.key}`}
              aria-selected={activeTab === tab.key}
              aria-controls="pet-tabpanel"
              className={activeTab === tab.key ? styles.sectionTabActive : styles.sectionTab}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className={`codicon ${tab.icon}`} aria-hidden="true" />
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <div
          className={styles.tabPanel}
          role="tabpanel"
          id="pet-tabpanel"
          aria-labelledby={`pet-tab-${activeTab}`}
        >
          {activeTab === 'basic' && (
            <BasicTab
              config={config}
              updateConfig={updateConfig}
              currentPet={currentPet}
              localPets={localPets}
              pendingPetOperation={pendingPetOperation}
              saveAlias={saveAlias}
              deleteCurrentPet={deleteCurrentPet}
              refreshPetAssets={refreshPetAssets}
            />
          )}
          {activeTab === 'actions' && (
            <ActionsTab
              config={config}
              updateConfig={updateConfig}
              currentPet={currentPet}
            />
          )}
          {activeTab === 'bubble' && (
            <BubbleTab
              config={config}
              updateConfig={updateConfig}
              updateConfigDraft={updateConfigDraft}
            />
          )}
          {activeTab === 'local' && (
            <LocalPetTab
              hatchStatus={hatchStatus}
              hatchName={hatchName}
              setHatchName={setHatchName}
              hatchDescription={hatchDescription}
              setHatchDescription={setHatchDescription}
              hatchStyle={hatchStyle}
              setHatchStyle={setHatchStyle}
              hatchReference={hatchReference}
              prepareHatchCommand={prepareHatchCommand}
              refreshPetAssets={refreshPetAssets}
            />
          )}
          {activeTab === 'petdex' && (
            <PetDexTab
              config={config}
              updateConfig={updateConfig}
              updateConfigDraft={updateConfigDraft}
              catalogState={catalogState}
              pendingPetOperation={pendingPetOperation}
              installPet={installPet}
              uninstallPet={uninstallPet}
            />
          )}
        </div>
      </div>
      <PetConfirmationDialog
        confirmation={confirmation}
        onConfirm={confirmOperation}
        onCancel={closeConfirmation}
      />
    </div>
  );
}
