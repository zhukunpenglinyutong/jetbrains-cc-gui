import { memo } from 'react';
import './Switch.css';

interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  /** antd-compatible alias: onClick(checked, event) */
  onClick?: (checked: boolean, e: React.MouseEvent) => void;
  disabled?: boolean;
  size?: 'small' | 'default';
  className?: string;
}

export const Switch = memo(function Switch({ checked, onChange, onClick, disabled, size, className }: SwitchProps) {
  const sizeClass = size === 'small' ? 'switch-small' : '';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`custom-switch ${sizeClass} ${checked ? 'switch-checked' : ''} ${className || ''}`}
      onClick={(e) => {
        const next = !checked;
        onClick?.(next, e);
        onChange?.(next);
      }}
    />
  );
});
