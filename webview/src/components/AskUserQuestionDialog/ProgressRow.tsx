import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../../utils/helpers';

interface ProgressRowProps {
  current: number;
  total: number;
  remainingSeconds: number;
  isTimeWarning: boolean;
}

const ProgressRow = ({
  current,
  total,
  remainingSeconds,
  isTimeWarning,
}: ProgressRowProps) => {
  const { t } = useTranslation();

  return (
    <div className="ask-user-question-dialog-progress-row">
      <span className="ask-user-question-dialog-progress">
        {t('askUserQuestion.progress', '问题 {{current}} / {{total}}', {
          current,
          total,
        })}
      </span>
      {/* Countdown display */}
      <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
        <span className="codicon codicon-clock" />
        <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
      </span>
    </div>
  );
};

export default ProgressRow;
