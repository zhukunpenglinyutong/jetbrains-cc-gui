import Switch from 'antd/es/switch';

const SWITCH_OPTION_STYLE: React.CSSProperties = {
  justifyContent: 'space-between',
  cursor: 'pointer',
};

const SWITCH_LABEL_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

interface ConfigSwitchOptionProps {
  icon: string;
  label: string;
  value?: boolean;
  defaultChecked: boolean;
  disabled?: boolean;
  title?: string;
  onChange?: (enabled: boolean) => void;
  onMouseEnter: () => void;
}

/**
 * ConfigSwitchOption - A switch row inside the ConfigSelect dropdown
 * (Streaming / Thinking): icon + label on the left, small Switch on the
 * right. Clicking the row toggles the current raw value.
 */
export const ConfigSwitchOption = ({
  icon,
  label,
  value,
  defaultChecked,
  disabled = false,
  title,
  onChange,
  onMouseEnter,
}: ConfigSwitchOptionProps) => (
  <div
    className={`selector-option${disabled ? ' disabled' : ''}`}
    aria-disabled={disabled}
    title={title}
    role="button"
    tabIndex={disabled ? -1 : 0}
    onClick={(e) => {
      e.stopPropagation();
      if (!disabled) onChange?.(!value);
    }}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onChange?.(!value);
      }
    }}
    onMouseEnter={onMouseEnter}
    style={SWITCH_OPTION_STYLE}
  >
    <div style={SWITCH_LABEL_STYLE}>
      <span className={`codicon ${icon}`} />
      <span>{label}</span>
    </div>
    <Switch
      size="small"
      disabled={disabled}
      checked={value ?? defaultChecked}
      onClick={(checked, e) => {
        e.stopPropagation();
        if (!disabled) onChange?.(checked);
      }}
    />
  </div>
);

export default ConfigSwitchOption;
