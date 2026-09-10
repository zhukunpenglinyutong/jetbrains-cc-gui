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
  onChange,
  onMouseEnter,
}: ConfigSwitchOptionProps) => (
  <div
    className="selector-option"
    onClick={(e) => {
      e.stopPropagation();
      onChange?.(!value);
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
      checked={value ?? defaultChecked}
      onClick={(checked, e) => {
        e.stopPropagation();
        onChange?.(checked);
      }}
    />
  </div>
);

export default ConfigSwitchOption;
