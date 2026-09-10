import { useTranslation } from 'react-i18next';
import type { ProviderPreset } from '../../types/provider';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';
import { OFFICIAL_DIRECT_PRESET_ID } from './useProviderForm';

interface PresetSectionsProps {
  activePreset: string;
  thirdPartyPresets: ProviderPreset[];
  onPresetClick: (presetId: string) => void;
}

export default function PresetSections({
  activePreset,
  thirdPartyPresets,
  onPresetClick,
}: PresetSectionsProps) {
  const { t } = useTranslation();

  return (
    <>
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
              <ProviderModelIcon providerId="claude" size={16} colored />
            </span>
            {t('settings.provider.dialog.officialPreset')}
          </button>
        </div>
        <small className="form-hint">{t('settings.provider.dialog.officialSectionHint')}</small>
      </div>

      <div className="form-group">
        <label>{t('settings.provider.dialog.proxySectionTitle')}</label>
        <div className="preset-buttons" role="radiogroup" aria-label={t('settings.provider.dialog.proxySectionTitle')}>
          {thirdPartyPresets.map((preset) => (
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
        <small className="form-hint">{t('settings.provider.dialog.proxySectionHint')}</small>
      </div>
    </>
  );
}
