import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../../utils/helpers';

interface CollapsedHintProps {
  current: number;
  total: number;
  isTimeWarning: boolean;
  remainingSeconds: number;
  onExpand: () => void;
}

const CollapsedHint = ({
  current,
  total,
  isTimeWarning,
  remainingSeconds,
  onExpand,
}: CollapsedHintProps) => {
  const { t } = useTranslation();

  return (
    <div className="collapsed-hint">
      <span className="collapsed-progress">
        {t('askUserQuestion.progress', '问题 {{current}} / {{total}}', {
          current,
          total,
        })}
      </span>
      {isTimeWarning && (
        <span className="collapsed-timer warning">
          <span className="codicon codicon-warning" />
          {formatCountdown(remainingSeconds)}
        </span>
      )}
      <button
        className="action-button primary expand-button"
        onClick={onExpand}
      >
        {t('askUserQuestion.clickToAnswer', '点击回答')}
      </button>
    </div>
  );
};

export default CollapsedHint;
