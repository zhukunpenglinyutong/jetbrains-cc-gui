import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexProviderConfig, CodexCustomModel } from '../types/provider';
import { CustomModelEditor } from './settings/CustomModelEditor';

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

  const [providerName, setProviderName] = useState('');
  const [configTomlJson, setConfigTomlJson] = useState('');
  const [authJson, setAuthJson] = useState('');
  const [customModels, setCustomModels] = useState<CodexCustomModel[]>([]);

  // Initialize form
  useEffect(() => {
    if (isOpen) {
      if (provider) {
        // Edit mode - load existing data
        setProviderName(provider.name || '');
        setConfigTomlJson(provider.configToml || '');
        setAuthJson(provider.authJson || '');
        setCustomModels(provider.customModels || []);
      } else {
        // Add mode - reset with default template
        setProviderName('');
        setConfigTomlJson(`disable_response_storage = true
model = "gpt-5.1-codex"
model_reasoning_effort = "high"
model_provider = "crs"

[model_providers.crs]
base_url = "https://api.example.com/v1"
name = "crs"
requires_openai_auth = true
wire_api = "responses"`);
        setAuthJson(`{
  "OPENAI_API_KEY": ""
}`);
        setCustomModels([]);
      }
    }
  }, [isOpen, provider]);

  // Format JSON
  const handleFormatConfigJson = () => {
    try {
      const parsed = JSON.parse(configTomlJson);
      setConfigTomlJson(JSON.stringify(parsed, null, 2));
      addToast(t('settings.codexProvider.dialog.formatSuccess'), 'success');
    } catch (e) {
      addToast(t('settings.codexProvider.dialog.formatError'), 'error');
    }
  };

  const handleFormatAuthJson = () => {
    try {
      const parsed = JSON.parse(authJson);
      setAuthJson(JSON.stringify(parsed, null, 2));
      addToast(t('settings.codexProvider.dialog.formatSuccess'), 'success');
    } catch (e) {
      addToast(t('settings.codexProvider.dialog.formatError'), 'error');
    }
  };

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

  const handleSave = () => {
    if (!providerName.trim()) {
      addToast(t('settings.codexProvider.dialog.nameRequired'), 'error');
      return;
    }

    // Validate auth.json format (must be valid JSON)
    if (authJson.trim()) {
      try {
        JSON.parse(authJson);
      } catch (e) {
        addToast(t('settings.codexProvider.dialog.authJsonError'), 'error');
        return;
      }
    }

    const providerData: CodexProviderConfig = {
      id: provider?.id || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString()),
      name: providerName.trim(),
      createdAt: provider?.createdAt,
      configToml: configTomlJson.trim(),
      authJson: authJson.trim(),
      customModels: customModels.length > 0 ? customModels : undefined,
    };

    onSave(providerData);
    onClose();
  };

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
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="configTomlJson">
                config.toml {t('settings.codexProvider.dialog.configJson')}
                <span className="required">{t('settings.provider.dialog.required')}</span>
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleFormatConfigJson}
                style={{ padding: '4px 8px', fontSize: '12px' }}
              >
                <span className="codicon codicon-symbol-namespace" />
                {t('settings.codexProvider.dialog.formatJson')}
              </button>
            </div>
            <textarea
              id="configTomlJson"
              className="form-input code-input"
              value={configTomlJson}
              onChange={(e) => setConfigTomlJson(e.target.value)}
              rows={15}
              style={{
                fontFamily: 'var(--idea-editor-font-family, monospace)',
                fontSize: '12px',
                lineHeight: '1.5'
              }}
            />
            <small className="form-hint">{t('settings.codexProvider.dialog.configJsonHint')}</small>
          </div>

          {/* auth.json */}
          <div className="form-group">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="authJson">
                auth.json {t('settings.codexProvider.dialog.authJsonLabel')}
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleFormatAuthJson}
                style={{ padding: '4px 8px', fontSize: '12px' }}
              >
                <span className="codicon codicon-symbol-namespace" />
                {t('settings.codexProvider.dialog.formatJson')}
              </button>
            </div>
            <textarea
              id="authJson"
              className="form-input code-input"
              value={authJson}
              onChange={(e) => setAuthJson(e.target.value)}
              rows={6}
              style={{
                fontFamily: 'var(--idea-editor-font-family, monospace)',
                fontSize: '12px',
                lineHeight: '1.5'
              }}
            />
            <small className="form-hint">{t('settings.codexProvider.dialog.authJsonHint')}</small>
          </div>

          {/* Custom Models */}
          <div className="form-group">
            <label>
              {t('settings.codexProvider.dialog.customModels')}
              <span className="optional">({t('common.optional')})</span>
            </label>
            <small className="form-hint" style={{ marginBottom: '8px', display: 'block' }}>
              {t('settings.codexProvider.dialog.customModelsHint')}
            </small>
            <CustomModelEditor
              models={customModels}
              onModelsChange={setCustomModels}
              t={t}
            />
          </div>
        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={{ marginLeft: 'auto' }}>
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
