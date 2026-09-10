import { useTranslation } from 'react-i18next';
import Switch from 'antd/es/switch';

const CONTEXT_SWITCH_STYLE: React.CSSProperties = {
  justifyContent: 'space-between',
  cursor: 'pointer',
};
const OPTION_LABEL_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };

interface ModelConfigContextRowProps {
  visible: boolean;
  supported: boolean;
  enabled: boolean;
  onChange?: (enabled: boolean) => void;
  onHover: () => void;
}

/**
 * 1M-context toggle row of the model-settings popover. The row itself is
 * clickable; the switch stops propagation so both paths toggle the same flag.
 */
export const ModelConfigContextRow = ({
  visible,
  supported,
  enabled,
  onChange,
  onHover,
}: ModelConfigContextRowProps) => {
  const { t } = useTranslation();
  if (!visible) return null;
  return (
    <div
      className="selector-option"
      data-testid="model-config-option-context"
      onClick={(event) => {
        event.stopPropagation();
        if (!supported) return;
        onChange?.(!enabled);
      }}
      onMouseEnter={onHover}
      style={CONTEXT_SWITCH_STYLE}
      title={supported
        ? t('models.longContext.tooltipEnabled')
        : t('models.longContext.tooltipDisabled')}
    >
      <span style={OPTION_LABEL_STYLE}>{t('modelConfig.context', { defaultValue: '1M Context' })}</span>
      <Switch
        size="small"
        checked={supported ? enabled : false}
        disabled={!supported}
        onClick={(checked, event) => {
          event.stopPropagation();
          onChange?.(checked);
        }}
      />
    </div>
  );
};
