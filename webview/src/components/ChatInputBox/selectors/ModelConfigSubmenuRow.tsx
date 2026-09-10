import type { ReactNode } from 'react';

const OPTION_RELATIVE_STYLE: React.CSSProperties = { position: 'relative', overflow: 'visible' };
const OPTION_LABEL_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };
const OPTION_VALUE_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  color: 'var(--text-secondary)',
  flexShrink: 0,
};
const ARROW_ICON_STYLE: React.CSSProperties = { fontSize: '12px' };

interface ModelConfigSubmenuRowProps {
  visible: boolean;
  active: boolean;
  testId: string;
  label: string;
  valueLabel: string;
  triggerRef: React.RefObject<HTMLDivElement | null>;
  onHover: () => void;
  onOpen: () => void;
  children: ReactNode;
}

/**
 * One function row of the model-settings popover (speed / preset / effort):
 * label, current value, chevron, and — while the row's submenu is active —
 * the fly-out rendered as `children` beside the row.
 */
export const ModelConfigSubmenuRow = ({
  visible,
  active,
  testId,
  label,
  valueLabel,
  triggerRef,
  onHover,
  onOpen,
  children,
}: ModelConfigSubmenuRowProps) => {
  if (!visible) return null;
  return (
    <div
      ref={triggerRef}
      className={`selector-option${active ? ' selected' : ''}`}
      data-testid={testId}
      onMouseEnter={onHover}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      style={OPTION_RELATIVE_STYLE}
    >
      <span style={OPTION_LABEL_STYLE}>{label}</span>
      <div style={OPTION_VALUE_STYLE}>
        <span>{valueLabel}</span>
        <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
      </div>
      {active && children}
    </div>
  );
};
