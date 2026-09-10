import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../../../types/provider';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';
import { sendToJava } from '../../../utils/bridge';
import { useDragSort } from '../hooks/useDragSort';
import ImportConfirmDialog from '../ProviderList/ImportConfirmDialog';
import CodexProviderCard from './CodexProviderCard';
import CliLoginCard from './CliLoginCard';
import CodexProviderDialogs from './CodexProviderDialogs';
import CodexProviderListHeader from './CodexProviderListHeader';
import sharedStyles from '../ProviderList/style.module.less';
import styles from './style.module.less';

interface CodexProviderSectionProps {
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  onRevokeCodexLocalConfigAuthorization: (fallbackProviderId?: string) => void;
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  showHeader?: boolean;
}

const CodexProviderSection = ({
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  onRevokeCodexLocalConfigAuthorization,
  addToast,
  showHeader = true,
}: CodexProviderSectionProps) => {
  const { t } = useTranslation();

  const [showCliLoginConfirm, setShowCliLoginConfirm] = useState(false);
  const [showCliLoginDisableConfirm, setShowCliLoginDisableConfirm] = useState(false);
  const [showLocalConfigHelp, setShowLocalConfigHelp] = useState(false);

  // cc-switch import state (Codex-scoped callbacks; both provider panels are
  // mounted simultaneously, so Codex must not reuse the Claude import globals)
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPreviewData, setImportPreviewData] = useState<any[]>([]);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(event.target as Node)) {
        setImportMenuOpen(false);
      }
    };

    // Register Codex-scoped global callbacks for Java invocation
    window.codex_import_preview_result = (dataOrStr) => {
      let data: unknown = dataOrStr;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          console.error('Failed to parse codex_import_preview_result data:', e);
        }
      }
      const event = new CustomEvent('codex_import_preview_result', { detail: data });
      window.dispatchEvent(event);
    };

    window.codex_cc_switch_notification = (...args: unknown[]) => {
      let data: any = {};
      if (args.length >= 3 && typeof args[0] === 'string' && typeof args[2] === 'string') {
        data = { type: args[0], title: args[1], message: args[2] };
      } else if (args.length > 0) {
        data = args[0] as any;
      }
      const event = new CustomEvent('codex_cc_switch_notification', { detail: data });
      window.dispatchEvent(event);
    };

    const handleImportPreview = (event: CustomEvent) => {
      setIsImporting(false);
      const data = event.detail;
      if (data && data.providers) {
        setImportPreviewData(data.providers);
        setShowImportDialog(true);
      }
    };

    const handleImportNotification = (event: CustomEvent) => {
      setIsImporting(false);
      const data = event.detail;
      if (data && data.message) {
        addToast(data.message, data.type || 'info');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('codex_import_preview_result', handleImportPreview as EventListener);
    window.addEventListener('codex_cc_switch_notification', handleImportNotification as EventListener);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('codex_import_preview_result', handleImportPreview as EventListener);
      window.removeEventListener('codex_cc_switch_notification', handleImportNotification as EventListener);
      delete window.codex_import_preview_result;
      delete window.codex_cc_switch_notification;
    };
  }, [addToast]);

  const handleSelectFileClick = () => {
    setImportMenuOpen(false);
    setIsImporting(true);
    sendToJava('open_file_chooser_for_codex_cc_switch');
  };

  const onSort = useCallback((orderedIds: string[]) => {
    sendToJava('sort_codex_providers', { orderedIds });
  }, []);

  // Filter out CLI Login provider from drag-sort list
  const regularProviders = useMemo(
    () => codexProviders.filter((p) => p.id !== SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );

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
    items: regularProviders,
    onSort,
  });

  const cliLoginProvider = useMemo(
    () => codexProviders.find((p) => p.id === SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN),
    [codexProviders]
  );
  const isCliLoginActive = cliLoginProvider?.isActive === true;

  return (
    <div className={styles.configSection}>
      {/* Import dialog */}
      {showImportDialog && (
        <ImportConfirmDialog
          providers={importPreviewData}
          existingProviders={codexProviders}
          onConfirm={(selectedProviders) => {
            sendToJava('save_imported_codex_providers', { providers: selectedProviders });
            setShowImportDialog(false);
          }}
          onCancel={() => setShowImportDialog(false)}
        />
      )}

      {/* Import loading */}
      {isImporting && (
        <div className={sharedStyles.loadingOverlay}>
          <div className={sharedStyles.loadingContent}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <span>{t('settings.provider.readingCcSwitch')}</span>
          </div>
        </div>
      )}

      {showHeader && (
        <>
          <h3 className={styles.sectionTitle}>{t('settings.codexProvider.title')}</h3>
          <p className={styles.sectionDesc}>{t('settings.codexProvider.description')}</p>
        </>
      )}

      <CodexProviderDialogs
        showCliLoginConfirm={showCliLoginConfirm}
        onCloseCliLoginConfirm={() => setShowCliLoginConfirm(false)}
        showCliLoginDisableConfirm={showCliLoginDisableConfirm}
        onCloseCliLoginDisableConfirm={() => setShowCliLoginDisableConfirm(false)}
        showLocalConfigHelp={showLocalConfigHelp}
        onCloseLocalConfigHelp={() => setShowLocalConfigHelp(false)}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
        firstRegularProviderId={regularProviders[0]?.id}
      />

      {codexLoading && (
        <div className={styles.tempNotice}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <p>{t('settings.provider.loading')}</p>
        </div>
      )}

      {!codexLoading && (
        <div className={styles.providerListContainer}>
          <CodexProviderListHeader
            importMenuRef={importMenuRef}
            importMenuOpen={importMenuOpen}
            onToggleImportMenu={() => setImportMenuOpen(!importMenuOpen)}
            onPreviewImport={() => {
              setImportMenuOpen(false);
              setIsImporting(true);
              sendToJava('preview_codex_cc_switch_import');
            }}
            onSelectFileClick={handleSelectFileClick}
            onAddCodexProvider={onAddCodexProvider}
          />

          <div className={sharedStyles.list}>
            {/* CLI Login virtual provider card (pinned at top) */}
            {cliLoginProvider && (
              <CliLoginCard
                isActive={isCliLoginActive}
                onShowHelp={() => setShowLocalConfigHelp(true)}
                onRequestAuthorize={() => setShowCliLoginConfirm(true)}
                onRequestDisable={() => setShowCliLoginDisableConfirm(true)}
              />
            )}

            {/* Regular providers (drag-sortable) */}
            {localProviders.length > 0 ? (
              localProviders.map((provider) => (
                <CodexProviderCard
                  key={provider.id}
                  provider={provider}
                  draggedProviderId={draggedProviderId}
                  dragOverProviderId={dragOverProviderId}
                  onPointerDown={handlePointerDown}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                  onSwitchCodexProvider={onSwitchCodexProvider}
                  onEditCodexProvider={onEditCodexProvider}
                  onDeleteCodexProvider={onDeleteCodexProvider}
                />
              ))
            ) : !cliLoginProvider ? (
              <div className={sharedStyles.emptyState}>
                <span className="codicon codicon-info" />
                <p>{t('settings.codexProvider.emptyProvider')}</p>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export default CodexProviderSection;
