import type { ReactNode } from 'react';

const FORM_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '12px',
  flexWrap: 'wrap',
};
const FORMAT_BUTTON_STYLE: React.CSSProperties = {
  width: 'auto',
  minWidth: 'auto',
  flex: '0 0 auto',
  padding: '4px 10px',
  fontSize: '12px',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};
const CODE_TEXTAREA_STYLE: React.CSSProperties = {
  fontFamily: 'var(--idea-editor-font-family, monospace)',
  fontSize: '12px',
  lineHeight: '1.5',
};

interface JsonFieldProps {
  id: string;
  label: ReactNode;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  formatLabel: string;
  onFormat: () => void;
}

export default function JsonField({
  id,
  label,
  hint,
  value,
  onChange,
  rows,
  formatLabel,
  onFormat,
}: JsonFieldProps) {
  return (
    <div className="form-group">
      <div style={FORM_HEADER_STYLE}>
        <label htmlFor={id}>{label}</label>
        <button
          type="button"
          className="btn-small"
          onClick={onFormat}
          style={FORMAT_BUTTON_STYLE}
          title={formatLabel}
        >
          <span className="codicon codicon-symbol-namespace" />
          {formatLabel}
        </button>
      </div>
      <textarea
        id={id}
        className="form-input code-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        style={CODE_TEXTAREA_STYLE}
      />
      <small className="form-hint">{hint}</small>
    </div>
  );
}
