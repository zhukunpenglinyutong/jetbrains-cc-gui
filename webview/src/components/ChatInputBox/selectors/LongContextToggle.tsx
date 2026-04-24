import { useTranslation } from 'react-i18next';
import { Switch } from 'antd';
import { modelSupports1MContext } from '../types';

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

  return (
    <div
      className="long-context-toggle"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        marginLeft: '4px',
        opacity: supports1M ? 1 : 0.5,
      }}
      title={supports1M
        ? t('models.longContext.tooltipEnabled')
        : t('models.longContext.tooltipDisabled')
      }
    >
      <span
        style={{
          fontSize: '11px',
          fontWeight: 500,
          color: displayEnabled ? 'var(--text-link-active)' : 'var(--text-secondary)',
        }}
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