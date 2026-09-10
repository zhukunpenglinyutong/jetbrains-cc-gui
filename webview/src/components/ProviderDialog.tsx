import { useTranslation } from 'react-i18next';
import type { ProviderConfig } from '../types/provider';
import PresetSections from './ProviderDialog/PresetSections';
import ProviderFormFields from './ProviderDialog/ProviderFormFields';
import ModelMappingSection from './ProviderDialog/ModelMappingSection';
import JsonConfigSection from './ProviderDialog/JsonConfigSection';
import ProviderDialogFooter from './ProviderDialog/ProviderDialogFooter';
import { useProviderForm } from './ProviderDialog/useProviderForm';

export {
  normalizeProviderEnvForSave,
  sanitizeProviderJsonConfig,
} from './ProviderDialog/providerConfigUtils';

interface ProviderDialogProps {
  isOpen: boolean;
  provider?: ProviderConfig | null; // null indicates add mode
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
  const {
    providerName,
    setProviderName,
    remark,
    setRemark,
    apiKey,
    apiUrl,
    showApiKey,
    setShowApiKey,
    activePreset,
    thirdPartyPresets,
    isOfficialDirectMode,
    showModelMappingSection,
    fableModel,
    sonnetModel,
    opusModel,
    haikuModel,
    jsonConfig,
    jsonError,
    handlePresetClick,
    handleFormatJson,
    handleApiKeyChange,
    handleApiUrlChange,
    handleFableModelChange,
    handleSonnetModelChange,
    handleOpusModelChange,
    handleHaikuModelChange,
    handleJsonChange,
    handleSave,
  } = useProviderForm({ isOpen, provider, onClose, onSave });

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

          <div className="notice-box notice-box--info">
            <span className="codicon codicon-shield" />
            {t('settings.provider.dialog.securityNotice')}
          </div>

          <PresetSections
            activePreset={activePreset}
            thirdPartyPresets={thirdPartyPresets}
            onPresetClick={handlePresetClick}
          />

          <ProviderFormFields
            providerName={providerName}
            remark={remark}
            apiKey={apiKey}
            apiUrl={apiUrl}
            showApiKey={showApiKey}
            isOfficialDirectMode={isOfficialDirectMode}
            onProviderNameChange={setProviderName}
            onRemarkChange={setRemark}
            onApiKeyChange={handleApiKeyChange}
            onToggleApiKeyVisibility={() => setShowApiKey(!showApiKey)}
            onApiUrlChange={handleApiUrlChange}
          />

          {showModelMappingSection && (
            <ModelMappingSection
              fableModel={fableModel}
              sonnetModel={sonnetModel}
              opusModel={opusModel}
              haikuModel={haikuModel}
              onFableModelChange={handleFableModelChange}
              onSonnetModelChange={handleSonnetModelChange}
              onOpusModelChange={handleOpusModelChange}
              onHaikuModelChange={handleHaikuModelChange}
            />
          )}

          <JsonConfigSection
            jsonConfig={jsonConfig}
            jsonError={jsonError}
            onJsonChange={handleJsonChange}
            onFormatJson={handleFormatJson}
          />
        </div>

        <ProviderDialogFooter
          isAdding={isAdding}
          onClose={onClose}
          onSave={handleSave}
        />
      </div>
    </div>
  );
}
