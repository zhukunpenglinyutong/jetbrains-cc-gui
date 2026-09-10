import { useTranslation } from 'react-i18next';
import { CODEX_PROVIDER_PRESETS } from '../../types/provider';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';

export const OFFICIAL_DIRECT_PRESET_ID = 'official_direct';

interface PresetSectionsProps {
  activePreset: string;
  onPresetClick: (presetId: string) => void;
}

export default function PresetSections({ activePreset, onPresetClick }: PresetSectionsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="notice-box notice-box--info">
        <span className="codicon codicon-shield" />
        {t('settings.provider.dialog.securityNotice')}
      </div>

      <div className="form-group">
        <label>{t('settings.provider.dialog.officialSectionTitle')}</label>
        <div className="preset-buttons" role="radiogroup" aria-label={t('settings.provider.dialog.officialSectionTitle')}>
          <button
            type="button"
            role="radio"
            aria-checked={activePreset === OFFICIAL_DIRECT_PRESET_ID}
            className={`preset-btn ${activePreset === OFFICIAL_DIRECT_PRESET_ID ? 'active' : ''}`}
            onClick={() => onPresetClick(OFFICIAL_DIRECT_PRESET_ID)}
          >
            <span aria-hidden="true" className="preset-btn-icon">
              <ProviderModelIcon providerId="codex" size={16} colored />
            </span>
            {t('settings.codexProvider.dialog.officialPreset')}
          </button>
        </div>
        <small className="form-hint">{t('settings.codexProvider.dialog.officialSectionHint')}</small>
      </div>

      <div className="form-group">
        <label>{t('settings.provider.dialog.proxySectionTitle')}</label>
        <div className="preset-buttons" role="radiogroup" aria-label={t('settings.provider.dialog.proxySectionTitle')}>
          {CODEX_PROVIDER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={activePreset === preset.id}
              className={`preset-btn ${activePreset === preset.id ? 'active' : ''}`}
              onClick={() => onPresetClick(preset.id)}
            >
              <span aria-hidden="true" className="preset-btn-icon">
                <ProviderModelIcon providerId={preset.id} size={16} colored />
              </span>
              {t(preset.nameKey)}
            </button>
          ))}
        </div>
        <small className="form-hint">{t('settings.codexProvider.dialog.presetHint')}</small>
      </div>
    </>
  );
}
