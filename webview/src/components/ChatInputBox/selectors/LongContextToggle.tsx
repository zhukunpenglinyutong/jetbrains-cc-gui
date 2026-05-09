import { useTranslation } from 'react-i18next';
import Switch from 'antd/es/switch';
import { modelSupports1MContext } from '../types';

const TOGGLE_BASE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  marginLeft: '4px',
};

const LABEL_BASE_STYLE: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 500,
};

interface LongContextToggleProps {
  /** Current model ID (to determine if toggle should be enabled) */
  modelId: string;
  /** Whether long context is enabled */
  enabled: boolean;
  /** Toggle callback */
  onChange: (enabled: boolean) => void;
}

/**
 * LongContextToggle - Toggle switch for 1M context window.
 * Positioned next to model selector. Only enabled for non-Haiku models.
 */
export const LongContextToggle = ({
  modelId,
  enabled,
  onChange,
}: LongContextToggleProps) => {
  const { t } = useTranslation();
  const supports1M = modelSupports1MContext(modelId);

  const displayEnabled = supports1M ? enabled : false;

  const wrapperStyle: React.CSSProperties = {
    ...TOGGLE_BASE_STYLE,
    opacity: supports1M ? 1 : 0.5,
  };

  const labelStyle: React.CSSProperties = {
    ...LABEL_BASE_STYLE,
    color: displayEnabled ? 'var(--text-link-active)' : 'var(--text-secondary)',
  };

  return (
    <div
      className="long-context-toggle"
      style={wrapperStyle}
      title={supports1M
        ? t('models.longContext.tooltipEnabled')
        : t('models.longContext.tooltipDisabled')
      }
    >
      <span
        style={labelStyle}
      >
        {t('models.longContext.label')}
      </span>
      <Switch
        size="small"
        checked={displayEnabled}
        disabled={!supports1M}
        onChange={onChange}
      />
    </div>
  );
};

export default LongContextToggle;
