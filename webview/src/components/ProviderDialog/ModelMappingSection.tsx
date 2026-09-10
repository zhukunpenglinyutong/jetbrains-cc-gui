import { useTranslation } from 'react-i18next';

interface ModelMappingSectionProps {
  fableModel: string;
  sonnetModel: string;
  opusModel: string;
  haikuModel: string;
  onFableModelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSonnetModelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onOpusModelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onHaikuModelChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export default function ModelMappingSection({
  fableModel,
  sonnetModel,
  opusModel,
  haikuModel,
  onFableModelChange,
  onSonnetModelChange,
  onOpusModelChange,
  onHaikuModelChange,
}: ModelMappingSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="form-group">
      <label>{t('settings.provider.dialog.modelMapping')}</label>
      <div className="model-mapping-grid">
        <div className="model-mapping-field">
          <label htmlFor="fableModel">{t('settings.provider.dialog.fableModel')}</label>
          <input
            id="fableModel"
            type="text"
            className="form-input"
            placeholder={t('settings.provider.dialog.fableModelPlaceholder')}
            value={fableModel}
            onChange={onFableModelChange}
          />
        </div>
        <div className="model-mapping-field">
          <label htmlFor="sonnetModel">{t('settings.provider.dialog.sonnetModel')}</label>
          <input
            id="sonnetModel"
            type="text"
            className="form-input"
            placeholder={t('settings.provider.dialog.sonnetModelPlaceholder')}
            value={sonnetModel}
            onChange={onSonnetModelChange}
          />
        </div>
        <div className="model-mapping-field">
          <label htmlFor="opusModel">{t('settings.provider.dialog.opusModel')}</label>
          <input
            id="opusModel"
            type="text"
            className="form-input"
            placeholder={t('settings.provider.dialog.opusModelPlaceholder')}
            value={opusModel}
            onChange={onOpusModelChange}
          />
        </div>
        <div className="model-mapping-field">
          <label htmlFor="haikuModel">{t('settings.provider.dialog.haikuModel')}</label>
          <input
            id="haikuModel"
            type="text"
            className="form-input"
            placeholder={t('settings.provider.dialog.haikuModelPlaceholder')}
            value={haikuModel}
            onChange={onHaikuModelChange}
          />
        </div>
      </div>
      <small className="form-hint">{t('settings.provider.dialog.modelMappingHint')}</small>
    </div>
  );
}
