import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../types/provider';

interface ProviderDialogProps {
  isOpen: boolean;
  provider?: ProviderConfig | null; // null 表示添加模式
  onClose: () => void;
  onSave: (data: {
    providerName: string;
    remark: string;
    apiKey: string;
    apiUrl: string;
    jsonConfig: string;
  }) => void;
  onDelete?: (provider: ProviderConfig) => void;
  canDelete?: boolean;
  addToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

export default function ProviderDialog({
  isOpen,
  provider,
  onClose,
  onSave,
  onDelete: _onDelete,
  canDelete: _canDelete = true,
  addToast: _addToast,
}: ProviderDialogProps) {
  const { t } = useTranslation();
  const isAdding = !provider;
  
  const [providerName, setProviderName] = useState('');
  const [remark, setRemark] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');

  const [haikuModel, setHaikuModel] = useState('');
  const [sonnetModel, setSonnetModel] = useState('');
  const [opusModel, setOpusModel] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [jsonConfig, setJsonConfig] = useState('');
  const [jsonError, setJsonError] = useState('');

  const updateEnvField = (key: string, value: string) => {
    try {
      const config = jsonConfig ? JSON.parse(jsonConfig) : {};
      if (!config.env) config.env = {};
      const env = config.env as Record<string, any>;
      const trimmed = typeof value === 'string' ? value.trim() : value;
      if (!trimmed) {
        if (Object.prototype.hasOwnProperty.call(env, key)) {
          delete env[key];
        }
        if (Object.keys(env).length === 0) {
          delete config.env;
        }
      } else {
        env[key] = value;
      }
      setJsonConfig(JSON.stringify(config, null, 2));
      setJsonError('');
    } catch {
    }
  };

  // 格式化 JSON
  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(jsonConfig);
      setJsonConfig(JSON.stringify(parsed, null, 2));
      setJsonError('');
    } catch (err) {
      setJsonError(t('settings.provider.dialog.jsonError'));
    }
  };

  // 初始化表单
  useEffect(() => {
    if (isOpen) {
      if (provider) {
        // 编辑模式
        setProviderName(provider.name || '');
        setRemark(provider.remark || provider.websiteUrl || '');
        setApiKey(provider.settingsConfig?.env?.ANTHROPIC_AUTH_TOKEN || provider.settingsConfig?.env?.ANTHROPIC_API_KEY || '');
        // 编辑模式下不填充默认值，避免覆盖用户实际使用的第三方代理 URL
        setApiUrl(provider.settingsConfig?.env?.ANTHROPIC_BASE_URL || '');
        const env = provider.settingsConfig?.env || {};

        setHaikuModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '');
        setSonnetModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL || '');
        setOpusModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL || '');

        const config = provider.settingsConfig || {
          env: {
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_BASE_URL: '',
            ANTHROPIC_MODEL: '',
            ANTHROPIC_DEFAULT_SONNET_MODEL: '',
            ANTHROPIC_DEFAULT_OPUS_MODEL: '',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
          }
        };
        setJsonConfig(JSON.stringify(config, null, 2));
      } else {
        // 添加模式
        setProviderName('');
        setRemark('');
        setApiKey('');
        setApiUrl('');

        setHaikuModel('');
        setSonnetModel('');
        setOpusModel('');
        const config = {
          env: {
            ANTHROPIC_AUTH_TOKEN: '',
            ANTHROPIC_BASE_URL: '',
            ANTHROPIC_MODEL: '',
            ANTHROPIC_DEFAULT_SONNET_MODEL: '',
            ANTHROPIC_DEFAULT_OPUS_MODEL: '',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
          }
        };
        setJsonConfig(JSON.stringify(config, null, 2));
      }
      setShowApiKey(false);
      setJsonError('');
    }
  }, [isOpen, provider]);

  // ESC 键关闭
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

  const handleApiKeyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newApiKey = e.target.value;
    setApiKey(newApiKey);
    updateEnvField('ANTHROPIC_AUTH_TOKEN', newApiKey);
  };

  const handleApiUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newApiUrl = e.target.value;
    setApiUrl(newApiUrl);
    updateEnvField('ANTHROPIC_BASE_URL', newApiUrl);
  };



  const handleHaikuModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setHaikuModel(value);
    updateEnvField('ANTHROPIC_DEFAULT_HAIKU_MODEL', value);
  };

  const handleSonnetModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSonnetModel(value);
    updateEnvField('ANTHROPIC_DEFAULT_SONNET_MODEL', value);
  };

  const handleOpusModelChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setOpusModel(value);
    updateEnvField('ANTHROPIC_DEFAULT_OPUS_MODEL', value);
  };

  const handleJsonChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newJson = e.target.value;
    setJsonConfig(newJson);
    
    try {
      const config = JSON.parse(newJson);
      const env = config.env || {};

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_AUTH_TOKEN')) {
        setApiKey(env.ANTHROPIC_AUTH_TOKEN || '');
      } else if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY')) {
        setApiKey(env.ANTHROPIC_API_KEY || '');
      } else {
        setApiKey('');
      }

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_BASE_URL')) {
        setApiUrl(env.ANTHROPIC_BASE_URL || '');
      } else {
        setApiUrl('');
      }



      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL')) {
        setHaikuModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '');
      } else {
        setHaikuModel('');
      }

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL')) {
        setSonnetModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL || '');
      } else {
        setSonnetModel('');
      }

      if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL')) {
        setOpusModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL || '');
      } else {
        setOpusModel('');
      }
      setJsonError('');
    } catch (err) {
      setJsonError(t('settings.provider.dialog.jsonError'));
    }
  };

  const handleSave = () => {
    onSave({
      providerName,
      remark,
      apiKey,
      apiUrl,
      jsonConfig,
    });
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog provider-dialog">
        <div className="dialog-header">
          <h3>{isAdding ? t('settings.provider.dialog.addTitle') : t('settings.provider.dialog.editTitle', { name: provider?.name })}</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <p className="dialog-desc">
            {isAdding ? t('settings.provider.dialog.addDescription') : t('settings.provider.dialog.editDescription')}
          </p>

          <div className="form-group">
            <label htmlFor="providerName">
              {t('settings.provider.dialog.providerName')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <input
              id="providerName"
              type="text"
              className="form-input"
              placeholder={t('settings.provider.dialog.providerNamePlaceholder')}
              value={providerName}
              onChange={(e) => setProviderName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="remark">{t('settings.provider.dialog.remark')}</label>
            <input
              id="remark"
              type="text"
              className="form-input"
              placeholder={t('settings.provider.dialog.remarkPlaceholder')}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="apiKey">
              {t('settings.provider.dialog.apiKey')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <div className="input-with-visibility">
              <input
                id="apiKey"
                type={showApiKey ? 'text' : 'password'}
                className="form-input"
                placeholder={t('settings.provider.dialog.apiKeyPlaceholder')}
                value={apiKey}
                onChange={handleApiKeyChange}
              />
              <button
                type="button"
                className="visibility-toggle"
                onClick={() => setShowApiKey(!showApiKey)}
                title={showApiKey ? t('settings.provider.dialog.hideApiKey') : t('settings.provider.dialog.showApiKey')}
              >
                <span className={`codicon ${showApiKey ? 'codicon-eye-closed' : 'codicon-eye'}`} />
              </button>
            </div>
            <small className="form-hint">{t('settings.provider.dialog.apiKeyHint')}</small>
          </div>

          <div className="form-group">
            <label htmlFor="apiUrl">
              {t('settings.provider.dialog.apiUrl')}
              <span className="required">{t('settings.provider.dialog.required')}</span>
            </label>
            <input
              id="apiUrl"
              type="text"
              className="form-input"
              placeholder={t('settings.provider.dialog.apiUrlPlaceholder')}
              value={apiUrl}
              onChange={handleApiUrlChange}
            />
            <small className="form-hint">
              <span className="codicon codicon-info" style={{ fontSize: '12px', marginRight: '4px' }} />
              {t('settings.provider.dialog.apiUrlHint')}
            </small>
          </div>

          <div className="form-group">
            <label>{t('settings.provider.dialog.modelMapping')}</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label htmlFor="sonnetModel">{t('settings.provider.dialog.sonnetModel')}</label>
                <input
                  id="sonnetModel"
                  type="text"
                  className="form-input"
                  placeholder={t('settings.provider.dialog.sonnetModelPlaceholder')}
                  value={sonnetModel}
                  onChange={handleSonnetModelChange}
                />
              </div>
              <div>
                <label htmlFor="opusModel">{t('settings.provider.dialog.opusModel')}</label>
                <input
                  id="opusModel"
                  type="text"
                  className="form-input"
                  placeholder={t('settings.provider.dialog.opusModelPlaceholder')}
                  value={opusModel}
                  onChange={handleOpusModelChange}
                />
              </div>
              <div>
                <label htmlFor="haikuModel">{t('settings.provider.dialog.haikuModel')}</label>
                <input
                  id="haikuModel"
                  type="text"
                  className="form-input"
                  placeholder={t('settings.provider.dialog.haikuModelPlaceholder')}
                  value={haikuModel}
                  onChange={handleHaikuModelChange}
                />
              </div>
            </div>
            <small className="form-hint">{t('settings.provider.dialog.modelMappingHint')}</small>
          </div>

          {/* 高级选项 - 暂时隐藏，后续会使用 */}
          {/* <details className="advanced-section">
            <summary className="advanced-toggle">
              <span className="codicon codicon-chevron-right" />
              高级选项
            </summary>
            <div style={{ padding: '10px 0', color: '#858585', fontSize: '13px' }}>
              暂无高级选项
            </div>
          </details> */}

          <details className="advanced-section" open>
            <summary className="advanced-toggle">
              <span className="codicon codicon-chevron-right" />
              {t('settings.provider.dialog.jsonConfig')}
            </summary>
            <div className="json-config-section">
              <p className="section-desc" style={{ marginBottom: '12px', fontSize: '12px', color: '#999' }}>
                {t('settings.provider.dialog.jsonConfigDescription')}
              </p>

              {/* 工具栏 */}
              <div className="json-toolbar">
                <button
                  type="button"
                  className="format-btn"
                  onClick={handleFormatJson}
                  title={t('settings.provider.dialog.formatJson') || '格式化 JSON'}
                >
                  <span className="codicon codicon-symbol-keyword" />
                  {t('settings.provider.dialog.formatJson') || '格式化'}
                </button>
              </div>

              <div className="json-editor-wrapper">
                <textarea
                  className="json-editor"
                  value={jsonConfig}
                  onChange={handleJsonChange}
                  placeholder={`{
  "env": {
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_MODEL": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": ""
  },
  "model": "sonnet",
  "alwaysThinkingEnabled": true,
  "ccSwitchProviderId": "default",
  "codemossProviderId": ""
}`}
                />
                {jsonError && (
                  <p className="json-error">
                    <span className="codicon codicon-error" />
                    {jsonError}
                  </p>
                )}
              </div>
            </div>
          </details>
        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={{ marginLeft: 'auto' }}>
            <button className="btn btn-secondary" onClick={onClose}>
              <span className="codicon codicon-close" />
              {t('common.cancel')}
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              <span className="codicon codicon-save" />
              {isAdding ? t('settings.provider.dialog.confirmAdd') : t('settings.provider.dialog.saveChanges')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
