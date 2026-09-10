import { useTranslation } from 'react-i18next';
import { isOfficialAnthropicEndpoint } from './useProviderForm';

const INFO_ICON_STYLE: React.CSSProperties = { fontSize: '12px', marginRight: '4px' };
const NOTICE_MT_STYLE: React.CSSProperties = { marginTop: '8px' };

interface ProviderFormFieldsProps {
  providerName: string;
  remark: string;
  apiKey: string;
  apiUrl: string;
  showApiKey: boolean;
  isOfficialDirectMode: boolean;
  onProviderNameChange: (value: string) => void;
  onRemarkChange: (value: string) => void;
  onApiKeyChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleApiKeyVisibility: () => void;
  onApiUrlChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function ProviderFormFields({
  providerName,
  remark,
  apiKey,
  apiUrl,
  showApiKey,
  isOfficialDirectMode,
  onProviderNameChange,
  onRemarkChange,
  onApiKeyChange,
  onToggleApiKeyVisibility,
  onApiUrlChange,
}: ProviderFormFieldsProps) {
  const { t } = useTranslation();

  return (
    <>
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
          onChange={(e) => onProviderNameChange(e.target.value)}
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
          onChange={(e) => onRemarkChange(e.target.value)}
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
            onChange={onApiKeyChange}
          />
          <button
            type="button"
            className="visibility-toggle"
            onClick={onToggleApiKeyVisibility}
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
          onChange={onApiUrlChange}
          readOnly={isOfficialDirectMode}
        />
        <small className="form-hint">
          <span className="codicon codicon-info" style={INFO_ICON_STYLE} />
          {isOfficialDirectMode
            ? t('settings.provider.dialog.apiUrlLockedHint')
            : t('settings.provider.dialog.apiUrlHint')}
        </small>
        {!isOfficialAnthropicEndpoint(apiUrl) && (
          <div className="notice-box notice-box--warning" style={NOTICE_MT_STYLE}>
            <span className="codicon codicon-cloud" />
            {t('settings.provider.dialog.proxyEndpointWarning')}
          </div>
        )}
      </div>
    </>
  );
}
