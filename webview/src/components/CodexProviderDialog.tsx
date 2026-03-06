import { useState, useEffect } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { CODEX_MODELS } from './ChatInputBox/types';
import type { CodexProviderConfig, CodexCustomModel } from '../types/provider';
import { STORAGE_KEYS, validateCodexCustomModels } from '../types/provider';

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
  const sectionStyle: CSSProperties = {
    border: '1px solid var(--idea-border-color, rgba(127,127,127,0.28))',
    borderRadius: '10px',
    padding: '14px',
    marginBottom: '14px',
    background: 'var(--idea-secondary-bg, rgba(127,127,127,0.06))',
  };
  const sectionTitleStyle: CSSProperties = {
    margin: '0 0 10px 0',
    fontSize: '13px',
    fontWeight: 600,
  };

  const [providerName, setProviderName] = useState('');
  const [configTomlJson, setConfigTomlJson] = useState('');
  const [authJson, setAuthJson] = useState('');
  const [httpProxy, setHttpProxy] = useState('');
  const [httpsProxy, setHttpsProxy] = useState('');
  const [allProxy, setAllProxy] = useState('');
  const [noProxy, setNoProxy] = useState('');

  // Initialize form
  useEffect(() => {
    if (isOpen) {
      if (provider) {
        // Edit mode - load existing data
        setProviderName(provider.name || '');
        setConfigTomlJson(provider.configToml || '');
        setAuthJson(provider.authJson || '');
        setHttpProxy(provider.proxy?.HTTP_PROXY || '');
        setHttpsProxy(provider.proxy?.HTTPS_PROXY || '');
        setAllProxy(provider.proxy?.ALL_PROXY || '');
        setNoProxy(provider.proxy?.NO_PROXY || '');
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
        setHttpProxy('');
        setHttpsProxy('');
        setAllProxy('');
        setNoProxy('');
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

  const handleSyncLatestModels = () => {
    try {
      if (typeof window === 'undefined' || !window.localStorage) {
        addToast(t('settings.codexProvider.dialog.syncLatestModelsUnavailable'), 'error');
        return;
      }
      const officialModels: CodexCustomModel[] = CODEX_MODELS.map((model) => ({
        id: model.id,
        label: model.label || model.id,
        description: model.description,
      }));
      const stored = window.localStorage.getItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS);
      const existing = stored ? validateCodexCustomModels(JSON.parse(stored)) : [];
      const merged = [...officialModels];
      const knownIds = new Set(officialModels.map((model) => model.id));

      for (const model of existing) {
        if (!knownIds.has(model.id)) {
          merged.push(model);
        }
      }

      window.localStorage.setItem(STORAGE_KEYS.CODEX_CUSTOM_MODELS, JSON.stringify(merged));
      window.dispatchEvent(new CustomEvent('localStorageChange', {
        detail: { key: STORAGE_KEYS.CODEX_CUSTOM_MODELS },
      }));
      addToast(t('settings.codexProvider.dialog.syncLatestModelsSuccess', { count: officialModels.length }), 'success');
    } catch (_error) {
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
    };

    const proxyConfig = {
      HTTP_PROXY: httpProxy.trim(),
      HTTPS_PROXY: httpsProxy.trim(),
      ALL_PROXY: allProxy.trim(),
      NO_PROXY: noProxy.trim(),
    };
    const hasProxyConfig = Object.values(proxyConfig).some((v) => v.length > 0);
    if (hasProxyConfig) {
      providerData.proxy = proxyConfig;
    }

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

          <div style={sectionStyle}>
            <h4 style={sectionTitleStyle}>{t('settings.codexProvider.dialog.providerSectionTitle')}</h4>
            <div className="form-group" style={{ marginBottom: 0 }}>
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
          </div>

          <div style={sectionStyle}>
            <h4 style={sectionTitleStyle}>{t('settings.codexProvider.dialog.configSectionTitle')}</h4>
            <div className="form-group" style={{ marginBottom: 0 }}>
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
          </div>

          <div style={sectionStyle}>
            <h4 style={sectionTitleStyle}>{t('settings.codexProvider.dialog.authSectionTitle')}</h4>
            <div className="form-group" style={{ marginBottom: 0 }}>
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
          </div>

          <div style={sectionStyle}>
            <h4 style={sectionTitleStyle}>{t('settings.codexProvider.dialog.proxyTitle')}</h4>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="httpProxy">HTTP_PROXY</label>
              <input
                id="httpProxy"
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.httpProxy')}
                value={httpProxy}
                onChange={(e) => setHttpProxy(e.target.value)}
              />

              <label htmlFor="httpsProxy" style={{ marginTop: '8px' }}>HTTPS_PROXY</label>
              <input
                id="httpsProxy"
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.httpsProxy')}
                value={httpsProxy}
                onChange={(e) => setHttpsProxy(e.target.value)}
              />

              <label htmlFor="allProxy" style={{ marginTop: '8px' }}>ALL_PROXY</label>
              <input
                id="allProxy"
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.allProxy')}
                value={allProxy}
                onChange={(e) => setAllProxy(e.target.value)}
              />

              <label htmlFor="noProxy" style={{ marginTop: '8px' }}>NO_PROXY</label>
              <input
                id="noProxy"
                type="text"
                className="form-input"
                placeholder={t('settings.codexProvider.dialog.noProxy')}
                value={noProxy}
                onChange={(e) => setNoProxy(e.target.value)}
              />

              <small className="form-hint">{t('settings.codexProvider.dialog.proxyHint')}</small>
            </div>
          </div>

          <div style={sectionStyle}>
            <h4 style={sectionTitleStyle}>{t('settings.codexProvider.dialog.modelsSectionTitle')}</h4>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                <small className="form-hint" style={{ margin: 0 }}>
                  {t('settings.codexProvider.dialog.syncLatestModelsHint')}
                </small>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleSyncLatestModels}
                >
                  <span className="codicon codicon-sync" />
                  {t('settings.codexProvider.dialog.syncLatestModels')}
                </button>
              </div>
            </div>
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
