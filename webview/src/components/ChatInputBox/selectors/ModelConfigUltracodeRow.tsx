import { useTranslation } from 'react-i18next';
import Switch from 'antd/es/switch';

interface ModelConfigUltracodeRowProps {
  visible: boolean;
  enabled: boolean;
  onChange?: (enabled: boolean) => void;
  onHover: () => void;
}

/** Native Claude workflow setting; it does not change the selected effort. */
export function ModelConfigUltracodeRow({ visible, enabled, onChange, onHover }: ModelConfigUltracodeRowProps) {
  const { t } = useTranslation();
  if (!visible) return null;
  // Native settings readback decides availability; effort levels are independent.
  const label = t('modelConfig.ultracode.label', { defaultValue: 'Ultracode' });
  return (
    <div
      className="selector-option"
      data-testid="model-config-option-ultracode"
      role="switch"
      aria-label={label}
      aria-checked={enabled}
      tabIndex={0}
      style={{ justifyContent: 'space-between', cursor: 'pointer' }}
      title={t('modelConfig.ultracode.description', { defaultValue: 'Native Claude workflow with automatic task delegation. Keeps your selected effort.' })}
      onMouseEnter={onHover}
      onClick={(event) => { event.stopPropagation(); onChange?.(!enabled); }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onChange?.(!enabled);
      }}
    >
      <span>{label}</span>
      <Switch
        size="small"
        checked={enabled}
        tabIndex={-1}
        aria-hidden="true"
        onClick={(checked, event) => { event.stopPropagation(); onChange?.(checked); }}
      />
    </div>
  );
}
