import { useTranslation } from 'react-i18next';
import Switch from 'antd/es/switch';

interface ModelConfigUltracodeRowProps {
  visible: boolean;
  supported: boolean;
  enabled: boolean;
  onChange?: (enabled: boolean) => void;
  onHover: () => void;
}

/** Native Claude workflow setting; it does not change the selected effort. */
export function ModelConfigUltracodeRow({ visible, supported, enabled, onChange, onHover }: ModelConfigUltracodeRowProps) {
  const { t } = useTranslation();
  if (!visible) return null;
  // An enabled preference can always be turned off after a model switch.
  const disabled = !supported && !enabled;
  const label = t('modelConfig.ultracode.label', { defaultValue: 'Ultracode' });
  return (
    <div
      className="selector-option"
      data-testid="model-config-option-ultracode"
      role="switch"
      aria-label={label}
      aria-checked={enabled}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      style={{ justifyContent: 'space-between', cursor: disabled ? 'default' : 'pointer' }}
      title={supported
        ? t('modelConfig.ultracode.description', { defaultValue: 'Native Claude workflow with automatic task delegation. Keeps your selected effort.' })
        : t('modelConfig.ultracode.unsupported', { defaultValue: 'Requires a model with XHigh effort and an available Ultracode workflow.' })}
      onMouseEnter={onHover}
      onClick={(event) => { event.stopPropagation(); if (!disabled) onChange?.(!enabled); }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) onChange?.(!enabled);
      }}
    >
      <span>{label}</span>
      <Switch
        size="small"
        checked={enabled}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden="true"
        onClick={(checked, event) => { event.stopPropagation(); onChange?.(checked); }}
      />
    </div>
  );
}
