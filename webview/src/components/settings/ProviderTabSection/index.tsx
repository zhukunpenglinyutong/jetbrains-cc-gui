import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, CodexProviderConfig } from '../../../types/provider';
import { STORAGE_KEYS } from '../../../types/provider';
import ProviderManageSection from '../ProviderManageSection';
import CodexProviderSection from '../CodexProviderSection';
import CustomModelDialog from '../CustomModelDialog';
import { usePluginModels } from '../hooks/usePluginModels';
import sharedStyles from '../ProviderList/style.module.less';
import styles from './style.module.less';

const BLOCK_STYLE: React.CSSProperties = { display: 'block' };
const NONE_STYLE: React.CSSProperties = { display: 'none' };
const ICON_14_STYLE: React.CSSProperties = { fontSize: 14 };
const ICON_MR_8_STYLE: React.CSSProperties = { marginRight: 8 };
const FLEX_1_STYLE: React.CSSProperties = { flex: 1 };

interface ProviderTabSectionProps {
  currentProvider: 'claude' | 'codex' | string;
  // Claude provider props
  providers: ProviderConfig[];
  loading: boolean;
  onAddProvider: () => void;
  onEditProvider: (provider: ProviderConfig) => void;
  onDeleteProvider: (provider: ProviderConfig) => void;
  onSwitchProvider: (id: string) => void;
  // Codex provider props
  codexProviders: CodexProviderConfig[];
  codexLoading: boolean;
  onAddCodexProvider: () => void;
  onEditCodexProvider: (provider: CodexProviderConfig) => void;
  onDeleteCodexProvider: (provider: CodexProviderConfig) => void;
  onSwitchCodexProvider: (id: string) => void;
  onRevokeCodexLocalConfigAuthorization: (fallbackProviderId?: string) => void;
  // OpenCode runtime authorization props
  openCodeAuthorized: boolean;
  openCodeLoading: boolean;
  onAuthorizeOpenCode: () => void;
  onRevokeOpenCodeAuthorization: () => void;
  // Shared
  addToast: (message: string, type: 'info' | 'success' | 'warning' | 'error') => void;
}

const ProviderTabSection = ({
  currentProvider,
  providers,
  loading,
  onAddProvider,
  onEditProvider,
  onDeleteProvider,
  onSwitchProvider,
  codexProviders,
  codexLoading,
  onAddCodexProvider,
  onEditCodexProvider,
  onDeleteCodexProvider,
  onSwitchCodexProvider,
  onRevokeCodexLocalConfigAuthorization,
  openCodeAuthorized,
  openCodeLoading,
  onAuthorizeOpenCode,
  onRevokeOpenCodeAuthorization,
  addToast,
}: ProviderTabSectionProps) => {
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<'claude' | 'codex' | 'opencode'>(
    () => currentProvider === 'codex' || currentProvider === 'opencode' ? currentProvider : 'claude'
  );

  // Plugin-level custom model management
  const claudeModels = usePluginModels(STORAGE_KEYS.CLAUDE_CUSTOM_MODELS);
  const codexModels = usePluginModels(STORAGE_KEYS.CODEX_CUSTOM_MODELS);

  // Dialog state
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [modelDialogAddMode, setModelDialogAddMode] = useState(false);
  const [showOpenCodeAuthorizeConfirm, setShowOpenCodeAuthorizeConfirm] = useState(false);
  const [showOpenCodeRevokeConfirm, setShowOpenCodeRevokeConfirm] = useState(false);
  // Which plugin's models the dialog is editing
  const [dialogTarget, setDialogTarget] = useState<'claude' | 'codex'>('claude');

  const openModelDialog = useCallback((target: 'claude' | 'codex', addMode = false) => {
    setDialogTarget(target);
    setModelDialogAddMode(addMode);
    setModelDialogOpen(true);
  }, []);

  const closeModelDialog = useCallback(() => {
    setModelDialogOpen(false);
    setModelDialogAddMode(false);
  }, []);

  const activeModels = dialogTarget === 'claude' ? claudeModels : codexModels;

  return (
    <div className={styles.providerTabSection}>
      <h3 className={styles.sectionTitle}>{t('settings.providers')}</h3>
      <p className={styles.sectionDesc}>{t('settings.providersDesc')}</p>

      <div className={styles.tabSelector} role="tablist" aria-label={t('settings.providers')}>
        <button
          role="tab"
          aria-selected={activeTab === 'claude'}
          aria-controls="panel-claude-providers"
          className={`${styles.tabBtn} ${activeTab === 'claude' ? styles.active : ''}`}
          onClick={() => setActiveTab('claude')}
        >
          <span className="codicon codicon-vm-connect" aria-hidden="true" />
          {t('settings.providerTab.claude')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'codex'}
          aria-controls="panel-codex-providers"
          className={`${styles.tabBtn} ${activeTab === 'codex' ? styles.active : ''}`}
          onClick={() => setActiveTab('codex')}
        >
          <span className="codicon codicon-terminal" aria-hidden="true" />
          {t('settings.providerTab.codex')}
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'opencode'}
          aria-controls="panel-opencode-providers"
          className={`${styles.tabBtn} ${activeTab === 'opencode' ? styles.active : ''}`}
          onClick={() => setActiveTab('opencode')}
        >
          <span className="codicon codicon-hubot" aria-hidden="true" />
          {t('settings.providerTab.opencode')}
        </button>
      </div>

      {/* Use display to preserve component state across tab switches */}
      <div id="panel-claude-providers" role="tabpanel" style={activeTab === 'claude' ? BLOCK_STYLE : NONE_STYLE}>
        <div
          className={styles.pluginModelsRow}
          onClick={() => openModelDialog('claude')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openModelDialog('claude'); }}
        >
          <span className="codicon codicon-symbol-misc" style={ICON_14_STYLE} />
          <span className={styles.pluginModelsLabel}>
            {t('settings.pluginModels.title')}
          </span>
          {claudeModels.models.length > 0 && (
            <span className={styles.pluginModelsBadge}>{claudeModels.models.length}</span>
          )}
          <span style={FLEX_1_STYLE} />
          <button
            className={styles.pluginModelsManageBtn}
            onClick={(e) => { e.stopPropagation(); openModelDialog('claude'); }}
          >
            {t('settings.pluginModels.manage')}
          </button>
        </div>
        <ProviderManageSection
          providers={providers}
          loading={loading}
          onAddProvider={onAddProvider}
          onEditProvider={onEditProvider}
          onDeleteProvider={onDeleteProvider}
          onSwitchProvider={onSwitchProvider}
          addToast={addToast}
          showHeader={false}
        />
      </div>

      <div id="panel-codex-providers" role="tabpanel" style={activeTab === 'codex' ? BLOCK_STYLE : NONE_STYLE}>
        <div
          className={styles.pluginModelsRow}
          onClick={() => openModelDialog('codex')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openModelDialog('codex'); }}
        >
          <span className="codicon codicon-symbol-misc" style={ICON_14_STYLE} />
          <span className={styles.pluginModelsLabel}>
            {t('settings.pluginModels.title')}
          </span>
          {codexModels.models.length > 0 && (
            <span className={styles.pluginModelsBadge}>{codexModels.models.length}</span>
          )}
          <span style={FLEX_1_STYLE} />
          <button
            className={styles.pluginModelsManageBtn}
            onClick={(e) => { e.stopPropagation(); openModelDialog('codex'); }}
          >
            {t('settings.pluginModels.manage')}
          </button>
        </div>
        <CodexProviderSection
          codexProviders={codexProviders}
          codexLoading={codexLoading}
          onAddCodexProvider={onAddCodexProvider}
          onEditCodexProvider={onEditCodexProvider}
          onDeleteCodexProvider={onDeleteCodexProvider}
          onSwitchCodexProvider={onSwitchCodexProvider}
          onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
          showHeader={false}
        />
      </div>

      <div id="panel-opencode-providers" role="tabpanel" style={activeTab === 'opencode' ? BLOCK_STYLE : NONE_STYLE}>
        {showOpenCodeAuthorizeConfirm && (
          <div className={sharedStyles.warningOverlay}>
            <div className={sharedStyles.warningDialog}>
              <div className={sharedStyles.warningTitle}>
                <span className="codicon codicon-key" />
                {t('settings.opencodeProvider.dialog.authorizeTitle')}
              </div>
              <div className={sharedStyles.warningContent}>
                {t('settings.opencodeProvider.dialog.authorizeMessage')}
                <br />
                <br />
                {t('settings.opencodeProvider.dialog.authorizeDetail')}
              </div>
              <div className={sharedStyles.warningActions}>
                <button
                  className={sharedStyles.btnSecondary}
                  onClick={() => setShowOpenCodeAuthorizeConfirm(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className={sharedStyles.btnPrimary}
                  onClick={() => {
                    setShowOpenCodeAuthorizeConfirm(false);
                    onAuthorizeOpenCode();
                  }}
                >
                  {t('settings.provider.authorizeAndEnable')}
                </button>
              </div>
            </div>
          </div>
        )}

        {showOpenCodeRevokeConfirm && (
          <div className={sharedStyles.warningOverlay}>
            <div className={sharedStyles.warningDialog}>
              <div className={sharedStyles.warningTitle}>
                <span className="codicon codicon-circle-slash" />
                {t('settings.opencodeProvider.dialog.revokeTitle')}
              </div>
              <div className={sharedStyles.warningContent}>
                {t('settings.opencodeProvider.dialog.revokeMessage')}
              </div>
              <div className={sharedStyles.warningActions}>
                <button
                  className={sharedStyles.btnSecondary}
                  onClick={() => setShowOpenCodeRevokeConfirm(false)}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className={sharedStyles.btnDanger}
                  onClick={() => {
                    setShowOpenCodeRevokeConfirm(false);
                    onRevokeOpenCodeAuthorization();
                  }}
                >
                  {t('settings.provider.revokeAuthorization')}
                </button>
              </div>
            </div>
          </div>
        )}

        {openCodeLoading && (
          <div className={styles.tempNotice}>
            <span className="codicon codicon-loading codicon-modifier-spin" />
            <p>{t('settings.provider.loading')}</p>
          </div>
        )}

        {!openCodeLoading && (
          <div className={styles.providerListContainer}>
            <div className={sharedStyles.header}>
              <h4 className={sharedStyles.title}>{t('settings.opencodeProvider.accessTitle')}</h4>
            </div>
            <div className={sharedStyles.list}>
              <div
                className={`${sharedStyles.card} ${openCodeAuthorized ? sharedStyles.active : ''} ${sharedStyles.localProviderCard}`}
              >
                <div className={sharedStyles.cardInfo}>
                  <div className={sharedStyles.name}>
                    <span className="codicon codicon-key" style={ICON_MR_8_STYLE} />
                    {t('settings.opencodeProvider.providerName')}
                  </div>
                  <div className={sharedStyles.website} title={t('settings.opencodeProvider.providerDescription')}>
                    {t('settings.opencodeProvider.providerDescription')}
                  </div>
                </div>
                <div className={sharedStyles.cardActions}>
                  {openCodeAuthorized ? (
                    <>
                      <div className={sharedStyles.activeBadge}>
                        <span className="codicon codicon-check" />
                        {t('settings.opencodeProvider.authorized')}
                      </div>
                      <button
                        className={sharedStyles.revokeButton}
                        onClick={() => setShowOpenCodeRevokeConfirm(true)}
                      >
                        <span className="codicon codicon-circle-slash" />
                        {t('settings.provider.revokeAuthorization')}
                      </button>
                    </>
                  ) : (
                    <button
                      className={sharedStyles.useButton}
                      onClick={() => setShowOpenCodeAuthorizeConfirm(true)}
                    >
                      <span className="codicon codicon-play" />
                      {t('settings.provider.authorizeAndEnable')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Shared model management dialog */}
      <CustomModelDialog
        isOpen={modelDialogOpen}
        models={activeModels.models}
        onModelsChange={activeModels.updateModels}
        onClose={closeModelDialog}
        initialAddMode={modelDialogAddMode}
      />
    </div>
  );
};

export default ProviderTabSection;
