import { memo, useCallback } from 'react';
import type { TFunction } from 'i18next';

const CONTEXT_WINDOW_PATTERNS = [
  /input exceeds context window/i,
  /context window.*exceed/i,
  /maximum context length/i,
  /context length.*exceed/i,
];

export function isContextWindowExceededError(errorText: string): boolean {
  return CONTEXT_WINDOW_PATTERNS.some((pattern) => pattern.test(errorText));
}

interface ContextRecoveryCardProps {
  t: TFunction;
  failedPrompt?: string;
  onStartRecovery?: (failedPrompt: string) => void;
  onStartEmptySession?: () => void;
}

const RecoveryIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 7h10a6 6 0 1 1-4.8 9.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M7 4 4 7l3 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ContextRecoveryCard = memo(function ContextRecoveryCard({
  t,
  failedPrompt,
  onStartRecovery,
  onStartEmptySession,
}: ContextRecoveryCardProps) {
  const handleStartRecovery = useCallback(() => {
    onStartRecovery?.(failedPrompt ?? '');
  }, [failedPrompt, onStartRecovery]);

  return (
    <div className="context-recovery-card">
      <div className="context-recovery-header">
        <span className="context-recovery-icon">
          <RecoveryIcon />
        </span>
        <span className="context-recovery-title">
          {t('contextRecovery.title', { defaultValue: 'Context window exceeded' })}
        </span>
      </div>

      <p className="context-recovery-intro">
        {t('contextRecovery.intro', {
          defaultValue: 'This opencode session is too large for the selected model. Start a fresh session with a bounded handoff prompt, then review it before sending.',
        })}
      </p>

      <div className="context-recovery-actions">
        <button
          type="button"
          className="context-recovery-primary-btn"
          onClick={handleStartRecovery}
        >
          {t('contextRecovery.startWithSummary', { defaultValue: 'Start new session with summary' })}
          <span className="context-recovery-recommended">
            {t('contextRecovery.recommended', { defaultValue: 'Recommended' })}
          </span>
        </button>
        <button
          type="button"
          className="context-recovery-secondary-btn"
          onClick={onStartEmptySession}
        >
          {t('contextRecovery.startEmpty', { defaultValue: 'Start empty new session' })}
        </button>
      </div>

      <p className="context-recovery-hint">
        {t('contextRecovery.retryHint', {
          defaultValue: 'Or retry with fewer attachments, file references, and pasted context.',
        })}
      </p>
    </div>
  );
});
