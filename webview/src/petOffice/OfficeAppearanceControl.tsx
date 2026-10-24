import Button from 'antd/es/button';
import Select from 'antd/es/select';
import { useTranslation } from 'react-i18next';
import type { OfficePetChoice } from './officeAppearanceOverrides';

interface OfficeAppearanceControlProps {
  value?: string; choices: readonly OfficePetChoice[]; loading: boolean; error: boolean; disabled: boolean;
  onChange: (id: string) => void; onRefresh: () => void;
}

/** Office-only binding override; clearing it resumes the source project's live configuration. */
export function OfficeAppearanceControl({ value, choices, loading, error, disabled, onChange, onRefresh }: OfficeAppearanceControlProps) {
  const { t } = useTranslation('petOffice');
  const options = [{ value: '', label: t('inheritAppearance') }, ...choices.map(choice => ({ value: choice.id, label: choice.id === 'builtin' ? t('builtinAppearance') : choice.label }))];
  if (value && !options.some(option => option.value === value)) options.push({ value, label: t('unavailableAppearance', { id: value }) });
  return <section className="office-appearance-control" aria-label={t('sessionAppearance')}>
    <label htmlFor="office-session-appearance" title={t('sessionAppearanceHint')}>{t('sessionAppearance')}</label>
    <div><Select id="office-session-appearance" size="small" aria-label={t('sessionAppearance')} value={value ?? ''} options={options} loading={loading} disabled={disabled}
      showSearch={{ optionFilterProp: 'label' }} onChange={onChange} />
      <Button size="small" aria-label={t('refreshAppearances')} title={t('refreshAppearances')} disabled={disabled || loading} onClick={onRefresh} icon={<svg aria-hidden="true" focusable="false" viewBox="0 0 20 20"><path d="M4 7a6.5 6.5 0 1 1-.2 5M4 3v4h4" /></svg>} /></div>
    {error ? <small className="office-warning" role="alert">{t('appearanceChoicesError')}</small> : null}
  </section>;
}
