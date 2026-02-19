import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

interface WaitingIndicatorProps {
  size?: number;
  /** Loading start timestamp (ms), used to maintain continuous timing across view switches */
  startTime?: number;
}

export const WaitingIndicator = ({ size = 18, startTime }: WaitingIndicatorProps) => {
  const { t } = useTranslation();
  const [dotCount, setDotCount] = useState(1);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    // If a start time is provided, calculate the elapsed seconds
    if (startTime) {
      return Math.floor((Date.now() - startTime) / 1000);
    }
    return 0;
  });

  // Ellipsis animation
  useEffect(() => {
    const timer = setInterval(() => {
      setDotCount(prev => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // Timer: track elapsed seconds for the current thinking round
  useEffect(() => {
    const timer = setInterval(() => {
      if (startTime) {
        // Calculate from the externally provided start time to avoid reset on view switches
        setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
      } else {
        setElapsedSeconds(prev => prev + 1);
      }
    }, 1000);

    return () => {
      clearInterval(timer);
    };
  }, [startTime]);

  const dots = '.'.repeat(dotCount);

  // Format elapsed time: show "X seconds" under 60s, "X min Y sec" above 60s
  const formatElapsedTime = (seconds: number): string => {
    if (seconds < 60) {
      return `${seconds} ${t('common.seconds')}`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${t('chat.minutesAndSeconds', { minutes, seconds: remainingSeconds })}`;
  };

  return (
    <div className="waiting-indicator">
      <span className="waiting-spinner" style={{ width: size, height: size }} />
      <span className="waiting-text">
	        {t('chat.generatingResponse')}<span className="waiting-dots">{dots}</span>
	        <span className="waiting-seconds">（{t('chat.elapsedTime', { time: formatElapsedTime(elapsedSeconds) })}）</span>
      </span>
    </div>
  );
};

export default WaitingIndicator;

