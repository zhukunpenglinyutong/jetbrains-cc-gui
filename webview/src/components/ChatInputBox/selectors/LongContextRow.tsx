import { useTranslation } from 'react-i18next';
import Switch from 'antd/es/switch';
import { modelSupports1MContext } from '../types';

const LONG_CONTEXT_OPTION_STYLE: React.CSSProperties = { justifyContent: 'space-between', cursor: 'default' };
const LONG_CONTEXT_LABEL_STYLE: React.CSSProperties = { fontSize: '12px' };

interface LongContextRowProps {
  hideLongContextToggle: boolean;
  currentProvider: string;
  value: string;
  longContextEnabled: boolean;
  onLongContextChange?: (enabled: boolean) => void;
}

/**
 * LongContextRow - The 1M context toggle row shown at the bottom of the model
 * dropdown for Claude providers.
 */
export const LongContextRow = ({
  hideLongContextToggle,
  currentProvider,
  value,
  longContextEnabled,
  onLongContextChange,
}: LongContextRowProps) => {
  const { t } = useTranslation();

  if (hideLongContextToggle || currentProvider !== 'claude' || !onLongContextChange) {
    return null;
  }

  return (
    <>
      <div className="selector-divider" />
      <div
        className="selector-option"
        style={LONG_CONTEXT_OPTION_STYLE}
        onClick={(e) => e.stopPropagation()}
      >
        <span style={LONG_CONTEXT_LABEL_STYLE}>{t('models.longContext.shortLabel')}</span>
        <Switch
          size="small"
          checked={modelSupports1MContext(value) ? longContextEnabled : false}
          disabled={!modelSupports1MContext(value)}
          onChange={onLongContextChange}
        />
      </div>
    </>
  );
};

export default LongContextRow;
