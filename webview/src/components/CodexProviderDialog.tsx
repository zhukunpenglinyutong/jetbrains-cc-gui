import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig } from '../types/provider';
import EnvVarsSection from './CodexProviderDialog/EnvVarsSection';
import JsonField from './CodexProviderDialog/JsonField';
import PresetSections from './CodexProviderDialog/PresetSections';
import { useCodexProviderForm } from './CodexProviderDialog/useCodexProviderForm';

const FOOTER_ACTIONS_STYLE: React.CSSProperties = { marginLeft: 'auto' };

interface CodexProviderDialogProps {
  isOpen: boolean;
  provider?: CodexProviderConfig | null;
  onClose: () => void;
  onSave: (provider: CodexProviderConfig) => void;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function CodexProviderDialog({
  isOpen,
  provider,
  onClose,
  onSave,
  addToast,
}: CodexProviderDialogProps) {
  const { t } = useTranslation();
  const isAdding = !provider;

  const {
    providerName,
    setProviderName,
    configTomlJson,
    setConfigTomlJson,
    authJson,
    setAuthJson,
    messageEnvVars,
    setMessageEnvVars,
    mcpEnvVars,
    setMcpEnvVars,
    activePreset,
    handlePresetClick,
    handleFormatConfigJson,
    handleFormatAuthJson,
    handleSave,
  } = useCodexProviderForm({ isOpen, provider, onSave, onClose, addToast });

  // ESC key to close
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog provider-dialog codex-provider-dialog">
        <div className="dialog-header">
          <h3>
            {isAdding
              ? t('settings.codexProvider.dialog.addTitle')
              : t('settings.codexProvider.dialog.editTitle', { name: provider?.name })}
          </h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            {isAdding
              ? t('settings.codexProvider.dialog.addDescription')
              : t('settings.codexProvider.dialog.editDescription')}
          </p>

          {isAdding && (
            <PresetSections activePreset={activePreset} onPresetClick={handlePresetClick} />
          )}

          {/* Provider Name */}
          <div className="form-group">
            <label htmlFor="providerName">
              {t('settings.codexProvider.dialog.providerName')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <input
              id="providerName"
              type="text"
              className="form-input"
              placeholder={t('settings.codexProvider.dialog.providerNamePlaceholder')}
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
            />
          </div>

          {/* config.toml JSON */}
          <JsonField
            id="configTomlJson"
            label={
              <>
                config.toml {t('settings.codexProvider.dialog.configJson')}
                <span className="required">{t('settings.provider.dialog.required')}</span>
              </>
            }
            hint={t('settings.codexProvider.dialog.configJsonHint')}
            value={configTomlJson}
            onChange={setConfigTomlJson}
            rows={15}
            formatLabel={t('settings.codexProvider.dialog.formatJson')}
            onFormat={handleFormatConfigJson}
          />

          {/* auth.json */}
          <JsonField
            id="authJson"
            label={<>auth.json {t('settings.codexProvider.dialog.authJsonLabel')}</>}
            hint={t('settings.codexProvider.dialog.authJsonHint')}
            value={authJson}
            onChange={setAuthJson}
            rows={6}
            formatLabel={t('settings.codexProvider.dialog.formatJson')}
            onFormat={handleFormatAuthJson}
          />

          {/* Environment Variables */}
          <EnvVarsSection
            messageEnvVars={messageEnvVars}
            mcpEnvVars={mcpEnvVars}
            onMessageEnvVarsChange={setMessageEnvVars}
            onMcpEnvVarsChange={setMcpEnvVars}
          />

        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={FOOTER_ACTIONS_STYLE}>
            <button className="btn btn-secondary" onClick={onClose}>
              <span className="codicon codicon-close" />
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={!providerName.trim()}>
              <span className="codicon codicon-save" />
              {isAdding ? t('settings.provider.dialog.confirmAdd') : t('settings.provider.dialog.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
