import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import { useDragSort } from '../hooks/useDragSort';
import ImportConfirmDialog from './ImportConfirmDialog';
import ProviderListHeader from './ProviderListHeader';
import ProviderListItem from './ProviderListItem';
import ProviderListOverlays from './ProviderListOverlays';
import SpecialProviderCard from './SpecialProviderCard';
import { useProviderListBridge } from './useProviderListBridge';
import styles from './style.module.less';

interface ProviderListProps {
  providers: ProviderConfig[];
  onAdd: () => void;
  onEdit: (provider: ProviderConfig) => void;
  onDelete: (provider: ProviderConfig) => void;
  onSwitch: (id: string) => void;
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  emptyState?: React.ReactNode;
}

export default function ProviderList({
  providers,
  onAdd,
  onEdit,
  onDelete,
  onSwitch,
  addToast,
  emptyState,
}: ProviderListProps) {
  const { t } = useTranslation();
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<any[]>([]);
  const [editingCcSwitchProvider, setEditingCcSwitchProvider] = useState<ProviderConfig | null>(null);
  const [convertingProvider, setConvertingProvider] = useState<ProviderConfig | null>(null);
  const [showLocalProviderConfirm, setShowLocalProviderConfirm] = useState(false);
  const [showLocalProviderDisableConfirm, setShowLocalProviderDisableConfirm] = useState(false);
  const [showCliLoginConfirm, setShowCliLoginConfirm] = useState(false);
  const [showCliLoginDisableConfirm, setShowCliLoginDisableConfirm] = useState(false);
  const [cliLoginAccountEmail, setCliLoginAccountEmail] = useState<string | null>(null);
  const [helpKind, setHelpKind] = useState<'local' | 'cli' | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  const onSort = useCallback((orderedIds: string[]) => {
    sendToJava('sort_providers', { orderedIds });
  }, []);

  const {
    localItems: localProviders,
    draggedId: draggedProviderId,
    dragOverId: dragOverProviderId,
    handlePointerDown,
    handleDragStart,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handleDragEnd,
  } = useDragSort({
    items: providers,
    onSort,
    pinnedIds: [SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS, SPECIAL_PROVIDER_IDS.CLI_LOGIN],
  });

  useProviderListBridge({
    addToast,
    importMenuRef,
    mountedRef,
    setImportMenuOpen,
    setIsImporting,
    setImportPreviewData,
    setShowImportDialog,
    setCliLoginAccountEmail,
  });

  const handleEditClick = (provider: ProviderConfig) => {
    if (provider.source === 'cc-switch') {
      setEditingCcSwitchProvider(provider);
    } else {
      onEdit(provider);
    }
  };

  const handleConvert = () => {
    if (convertingProvider) {
      // 1. Generate a new ID (e.g., append _custom or _local to the original ID, or keep the original ID but remove the source field)
      // The user wants to "disconnect the ID link", meaning cc-switch imports match by ID.
      // If we keep the original ID and only remove the source field:
      //   - The next cc-switch import would still match by ID and prompt an "update".
      //   - After overwriting, the source field would come back.
      // Therefore, to fully "disconnect", we need to change the ID.

      const oldId = convertingProvider.id;
      const newId = `${oldId}_local`; // Or use uuid; appending suffix here for simplicity

      // 2. Build the new configuration
      const newProvider = {
          ...convertingProvider,
          id: newId,
          name: convertingProvider.name + ' (Local)', // Optional: rename to avoid confusion
      };
      delete newProvider.source;

      // 3. Save the new configuration (as an addition)
      sendToJava('add_provider', newProvider);

      // 4. Delete the old configuration
      sendToJava('delete_provider', { id: oldId });

      setConvertingProvider(null);
      addToast(t('settings.provider.convertSuccess'), 'success');

      if (editingCcSwitchProvider && editingCcSwitchProvider.id === convertingProvider.id) {
          setEditingCcSwitchProvider(null);
          // Continue editing the new provider
          onEdit(newProvider);
      }
    }
  };

  const handleSelectFileClick = () => {
    setImportMenuOpen(false);
    setIsImporting(true);
    // Let the backend open the system file chooser to get the correct absolute path
    sendToJava('open_file_chooser_for_cc_switch');
  };

  const localProviderActive = localProviders.some(p => p.id === SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS && p.isActive);
  const cliLoginActive = localProviders.some(p => p.id === SPECIAL_PROVIDER_IDS.CLI_LOGIN && p.isActive);
  const regularProviders = localProviders.filter(p => p.id !== SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS && p.id !== SPECIAL_PROVIDER_IDS.CLI_LOGIN);
  const hasNonLocalProviders = localProviders.some(p => p.id !== SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS);

  return (
    <div className={styles.container}>
      {/* Import dialog */}
      {showImportDialog && (
        <ImportConfirmDialog
          providers={importPreviewData}
          existingProviders={providers}
          onConfirm={(selectedProviders) => {
            sendToJava('save_imported_providers', { providers: selectedProviders });
            setShowImportDialog(false);
          }}
          onCancel={() => setShowImportDialog(false)}
        />
      )}

      {/* Import loading */}
      {isImporting && (
        <div className={styles.loadingOverlay}>
          <div className={styles.loadingContent}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.provider.readingCcSwitch')}</span>
          </div>
        </div>
      )}

      <ProviderListOverlays
        editingCcSwitchProvider={editingCcSwitchProvider}
        convertingProvider={convertingProvider}
        showLocalProviderConfirm={showLocalProviderConfirm}
        showLocalProviderDisableConfirm={showLocalProviderDisableConfirm}
        showCliLoginConfirm={showCliLoginConfirm}
        showCliLoginDisableConfirm={showCliLoginDisableConfirm}
        helpKind={helpKind}
        setEditingCcSwitchProvider={setEditingCcSwitchProvider}
        setConvertingProvider={setConvertingProvider}
        setShowLocalProviderConfirm={setShowLocalProviderConfirm}
        setShowLocalProviderDisableConfirm={setShowLocalProviderDisableConfirm}
        setShowCliLoginConfirm={setShowCliLoginConfirm}
        setShowCliLoginDisableConfirm={setShowCliLoginDisableConfirm}
        setCliLoginAccountEmail={setCliLoginAccountEmail}
        setHelpKind={setHelpKind}
        onEdit={onEdit}
        onSwitch={onSwitch}
        onConvertConfirm={handleConvert}
      />

      <ProviderListHeader
        importMenuOpen={importMenuOpen}
        importMenuRef={importMenuRef}
        onToggleImportMenu={() => setImportMenuOpen(!importMenuOpen)}
        onPreviewImport={() => {
          setImportMenuOpen(false);
          setIsImporting(true); // Start loading
          sendToJava('preview_cc_switch_import');
        }}
        onSelectFile={handleSelectFileClick}
        onAdd={onAdd}
      />

      <div className={styles.list}>
        <>
          <SpecialProviderCard
            key={SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS}
            iconClass="codicon-file"
            name={t('settings.provider.localProviderName')}
            isActive={localProviderActive}
            onHelp={() => setHelpKind('local')}
            onRevoke={() => setShowLocalProviderDisableConfirm(true)}
            onEnable={() => setShowLocalProviderConfirm(true)}
          />

          <SpecialProviderCard
            key={SPECIAL_PROVIDER_IDS.CLI_LOGIN}
            iconClass="codicon-key"
            name={t('settings.provider.cliLoginProviderName')}
            isActive={cliLoginActive}
            accountInfo={cliLoginAccountEmail
              ? t('settings.provider.cliLoginAccountInfo', { email: cliLoginAccountEmail })
              : undefined}
            onHelp={() => setHelpKind('cli')}
            onRevoke={() => setShowCliLoginDisableConfirm(true)}
            onEnable={() => setShowCliLoginConfirm(true)}
          />

          {regularProviders.map((provider) => (
            <ProviderListItem
              key={provider.id}
              provider={provider}
              isDragging={draggedProviderId === provider.id}
              isDragOver={dragOverProviderId === provider.id}
              onSwitch={onSwitch}
              onEdit={handleEditClick}
              onDelete={onDelete}
              onConvert={setConvertingProvider}
              handlePointerDown={handlePointerDown}
              handleDragStart={handleDragStart}
              handleDragOver={handleDragOver}
              handleDragLeave={handleDragLeave}
              handleDrop={handleDrop}
              handleDragEnd={handleDragEnd}
            />
          ))}

          {!hasNonLocalProviders && emptyState ? (
            <div className={styles.emptyState}>
              {emptyState}
            </div>
          ) : null}
        </>
      </div>
    </div>
  );
}
