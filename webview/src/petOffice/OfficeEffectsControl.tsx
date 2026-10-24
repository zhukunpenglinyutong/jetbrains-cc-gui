import Button from 'antd/es/button';
import Popover from 'antd/es/popover';
import Radio from 'antd/es/radio';
import Switch from 'antd/es/switch';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { OFFICE_MARGIN_MODES } from './officeMarginEffects';
import type { OfficeMarginPreferences } from './officeMarginEffects';

export interface OfficeEffectsOptionsProps { value: OfficeMarginPreferences; error: boolean; onChange: (value: OfficeMarginPreferences) => void }

/** The header and settings share the same accessible decoration controls. */
export function OfficeEffectsOptions({ value, error, onChange, expanded = false }: OfficeEffectsOptionsProps & { expanded?: boolean }) {
  const { t } = useTranslation('petOffice');
  const toggleId = useId();
  return <div className={`office-effects-options${expanded ? ' is-expanded' : ''}`}>
    <div className="office-effects-toggle"><label htmlFor={toggleId}>{t('enableMarginEffects')}</label><Switch id={toggleId} size="small" aria-label={t('enableMarginEffects')} checked={value.enabled} onChange={enabled => onChange({ ...value, enabled })} /></div>
    <Radio.Group aria-label={t('marginEffectStyle')} value={value.mode} onChange={event => {
      const mode = OFFICE_MARGIN_MODES.find(item => item === event.target.value);
      if (mode) onChange({ enabled: true, mode });
    }}>{OFFICE_MARGIN_MODES.map(mode => <Radio.Button value={mode} key={mode} aria-label={t(`marginModes.${mode}`)}>
      <span aria-hidden="true" className={`office-effect-swatch is-${mode}`} />
      <span className="office-effect-name"><span>{t(`marginModes.${mode}`)}</span>{expanded ? <span aria-hidden="true" className="office-effect-check">✓</span> : null}</span>
      {expanded ? <span className="office-effect-description">{t(`marginDescriptions.${mode}`)}</span> : null}
    </Radio.Button>)}</Radio.Group>
    <p>{t('marginEffectsHint')}</p>{error ? <p className="office-warning" role="alert">{t('marginEffectsStorageError')}</p> : null}
  </div>;
}

export function OfficeEffectsControl(props: OfficeEffectsOptionsProps) {
  const { t } = useTranslation('petOffice');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <span className="office-effects-control" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
  }}><Popover open={open} onOpenChange={setOpen} trigger="click" placement="bottomRight" title={t('marginEffects')} classNames={{ root: 'office-effects-popover' }} content={<OfficeEffectsOptions {...props} />}>
    <Button ref={trigger} size="small" className="office-effects-trigger" aria-label={t('marginEffects')} title={t('marginEffects')} aria-pressed={props.value.enabled} aria-expanded={open}>
      <span className={`office-effects-indicator${props.value.enabled ? ' is-enabled' : ''}`} aria-hidden="true" />{props.value.enabled ? t(`marginModes.${props.value.mode}`) : t('marginEffectsOff')}
    </Button>
  </Popover></span>;
}
