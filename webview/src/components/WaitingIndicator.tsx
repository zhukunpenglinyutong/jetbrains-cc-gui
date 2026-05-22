import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { QueueDisplayState } from '../contexts/MessagesContext';

interface WaitingIndicatorProps {
  /** Loading start timestamp (ms), used to maintain continuous timing across view switches */
  startTime?: number;
  queueDisplayState?: QueueDisplayState;
  queueAheadCount?: number;
  loading?: boolean;
  onExitComplete?: () => void;
}

type ContentMode = 'queued' | 'generating';
type AnimationPhase = 'entering' | 'exiting' | 'unmounting';

export const WaitingIndicator = ({
  startTime,
  queueDisplayState = 'NONE',
  queueAheadCount = 0,
  loading = true,
  onExitComplete,
}: WaitingIndicatorProps) => {
  const { t } = useTranslation();
  const isQueued = queueDisplayState === 'QUEUED';

  // ── Content display state ──
  const [displayedMode, setDisplayedMode] = useState<ContentMode>(
    isQueued ? 'queued' : 'generating'
  );
  const [phase, setPhase] = useState<AnimationPhase>('entering');

  // ── Refs for timer cleanup ──
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLoadingRef = useRef(loading);
  const prevIsQueuedRef = useRef(isQueued);

  // ── Existing state (unchanged) ──
  const [dotCount, setDotCount] = useState(1);
  const [elapsedSeconds, setElapsedSeconds] = useState(() => {
    // If a start time is provided, calculate the elapsed seconds
    if (startTime) {
      return Math.floor((Date.now() - startTime) / 1000);
    }
    return 0;
  });

  // ── Cleanup timer on unmount ──
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);

  // ── Animation state machine ──
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    const wasQueued = prevIsQueuedRef.current;
    prevLoadingRef.current = loading;
    prevIsQueuedRef.current = isQueued;

    // Case 1: loading → false  →  container exit
    if (wasLoading && !loading) {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
      setPhase('unmounting');
      transitionTimerRef.current = setTimeout(() => {
        onExitComplete?.();
      }, 250);
      return;
    }

    // Case 2: content swap (queued ↔ generating)
    if (loading && wasQueued !== isQueued && phase !== 'unmounting') {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
      setPhase('exiting');
      transitionTimerRef.current = setTimeout(() => {
        setDisplayedMode(isQueued ? 'queued' : 'generating');
        setPhase('entering');
      }, 250);
    }
  }, [loading, isQueued, onExitComplete, phase]);

  // ── Ellipsis animation ──
  useEffect(() => {
    const timer = setInterval(() => {
      setDotCount(prev => (prev % 3) + 1);
    }, 500);
    return () => clearInterval(timer);
  }, []);

  // ── Timer: track elapsed seconds for the current thinking round ──
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

  // ── Formatting helpers (unchanged) ──
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

  // ── CSS class resolution ──
  const containerClass = [
    'waiting-indicator',
    displayedMode === 'queued' ? 'waiting-indicator-queued' : '',
    phase === 'unmounting' ? 'waiting-indicator-exit' : '',
  ].filter(Boolean).join(' ');

  const contentEnterClass = 'queue-pill-enter';
  const contentExitClass = phase === 'exiting' ? 'waiting-content-exit' : '';
  const contentClass = [phase === 'entering' ? contentEnterClass : '', contentExitClass]
    .filter(Boolean).join(' ');

  // ── Render ──
  return (
    <div className={containerClass}>
      {displayedMode === 'queued' ? (
        <span className={`queue-pill ${contentClass}`}>
          {t('chat.queueWaiting', { count: queueAheadCount })}
          <span className="queue-pill-dot" />
        </span>
      ) : (
        <span className={`queue-pill queue-pill-generating ${contentClass}`}>
          {t('chat.generatingResponse')}<span className="waiting-dots">{dots}</span>
          <span className="waiting-seconds">（{t('chat.elapsedTime', { time: formatElapsedTime(elapsedSeconds) })}）</span>
          <span className="queue-pill-dot" />
        </span>
      )}
    </div>
  );
};

export default WaitingIndicator;
