import { memo, useState, useCallback, useSyncExternalStore } from 'react';
import type { TFunction } from 'i18next';
import type { DiagnosticPattern, DiagnosticStep } from '../../utils/errorMatcher';
import { copyToClipboard } from '../../utils/copyUtils';
import { openBrowserExternal } from '../../utils/bridge';
import {
  getClaudeSdkUpdateSnapshot,
  requestClaudeSdkUpdate,
  subscribeClaudeSdkUpdate,
  type ClaudeSdkUpdateResult,
} from '../../utils/claudeSdkUpdate';

/** When the error was shown; the host sends epoch milliseconds, history may carry ISO strings. */
type ErrorTimestamp = string | number;

interface ErrorDiagnosticCardProps {
  t: TFunction;
  pattern: DiagnosticPattern;
  errorTimestamp?: ErrorTimestamp;
  onNavigateToDependencySettings?: () => void;
}

const InfoIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
    <path d="M12 8h.01M11 12h1v5h1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 4l0 8a2 2 0 0 0 2 2l8 0a2 2 0 0 0 2 -2l0 -8a2 2 0 0 0 -2 -2l-8 0a2 2 0 0 0 -2 2zm2 0l8 0l0 8l-8 0l0 -8z" fill="currentColor"/>
    <path d="M2 2l0 8l-2 0l0 -8a2 2 0 0 1 2 -2l8 0l0 2l-8 0z" fill="currentColor" fillOpacity="0.6"/>
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ArrowRightIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 12h14m-7-7 7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface CommandBlockProps {
  command: string;
  t: TFunction;
}

const CommandBlock = memo(function CommandBlock({ command, t }: CommandBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(command);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [command]);

  return (
    <div className="error-diagnostic-command">
      <code className="error-diagnostic-command-text">{command}</code>
      <button
        type="button"
        className={`error-diagnostic-copy-btn${copied ? ' copied' : ''}`}
        onClick={handleCopy}
        title={t('errorDiagnostic.copyCommand')}
        aria-label={t('errorDiagnostic.copyCommand')}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span className="error-diagnostic-copy-label">
          {copied ? t('errorDiagnostic.copied') : t('errorDiagnostic.copyCommand')}
        </span>
      </button>
    </div>
  );
});

function toEpochMs(timestamp?: ErrorTimestamp): number | undefined {
  const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : timestamp;
  return ms !== undefined && Number.isFinite(ms) ? ms : undefined;
}

function describeUpdateSuccess(t: TFunction, result: ClaudeSdkUpdateResult) {
  const version = result.installedVersion ?? 'unknown';
  if (result.customCliPath) {
    return { warning: true, text: t('errorDiagnostic.updateClaudeSdkCustomCli', { version, path: result.customCliPath }) };
  }
  if (result.installedVersion && result.installedVersion === result.previousVersion) {
    return { warning: true, text: t('errorDiagnostic.updateClaudeSdkAlreadyLatest', { version }) };
  }
  return { warning: false, text: t('errorDiagnostic.updateClaudeSdkSuccess', { version }) };
}

function describeUpdateFailure(t: TFunction, result: ClaudeSdkUpdateResult) {
  if (result.timedOut) {
    return t('errorDiagnostic.updateClaudeSdkTimedOut');
  }
  return result.error
    ? t('errorDiagnostic.updateClaudeSdkFailed', { error: result.error })
    : t('errorDiagnostic.updateClaudeSdkFailedUnknown');
}

interface UpdateClaudeSdkActionProps {
  t: TFunction;
  errorTimestamp?: ErrorTimestamp;
  onNavigateToDependencySettings?: () => void;
}

const UpdateClaudeSdkAction = memo(function UpdateClaudeSdkAction({
  t,
  errorTimestamp,
  onNavigateToDependencySettings,
}: UpdateClaudeSdkActionProps) {
  const update = useSyncExternalStore(subscribeClaudeSdkUpdate, getClaudeSdkUpdateSnapshot);
  const [requested, setRequested] = useState(false);

  const handleUpdate = useCallback(() => {
    setRequested(true);
    void requestClaudeSdkUpdate();
  }, []);

  // An update that finished after this error answers it, even when the card remounted since;
  // the same error shown after that update gets the button again.
  const errorAt = toEpochMs(errorTimestamp);
  const answered = update.completedAt !== undefined
    && (errorAt !== undefined ? errorAt <= update.completedAt : requested);
  const result = answered ? update.lastResult : undefined;

  if (update.updating) {
    return (
      <>
        <button type="button" className="error-diagnostic-nav-btn" disabled>
          {t('errorDiagnostic.updatingClaudeSdk')}
        </button>
        {update.progress && (
          <p className="error-diagnostic-action-progress" aria-live="polite">{update.progress}</p>
        )}
      </>
    );
  }

  if (result?.success) {
    const { warning, text } = describeUpdateSuccess(t, result);
    return (
      <p className={`error-diagnostic-action-status ${warning ? 'warning' : 'success'}`} role="status">
        {text}
      </p>
    );
  }

  return (
    <>
      <button type="button" className="error-diagnostic-nav-btn" onClick={handleUpdate}>
        {t('errorDiagnostic.updateClaudeSdk')}
      </button>
      {result && (
        <>
          <p className="error-diagnostic-action-status error" role="alert">
            {describeUpdateFailure(t, result)}
          </p>
          {onNavigateToDependencySettings && (
            <button
              type="button"
              className="error-diagnostic-nav-btn"
              onClick={onNavigateToDependencySettings}
            >
              {t('errorDiagnostic.openDependencySettings')}
              <ArrowRightIcon />
            </button>
          )}
        </>
      )}
    </>
  );
});

interface StepRendererProps {
  step: DiagnosticStep;
  description: string;
  t: TFunction;
  errorTimestamp?: ErrorTimestamp;
  onNavigateToDependencySettings?: () => void;
}

function StepRenderer({ step, description, t, errorTimestamp, onNavigateToDependencySettings }: StepRendererProps) {
  if (step.kind === 'command') {
    return (
      <div className="error-diagnostic-step">
        <p className="error-diagnostic-step-text">{description}</p>
        <CommandBlock command={step.command} t={t} />
      </div>
    );
  }

  if (step.kind === 'link') {
    return (
      <div className="error-diagnostic-step">
        <p className="error-diagnostic-step-text">{description}</p>
        <a
          className="error-diagnostic-nav-btn"
          href={step.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => {
            // JCEF won't route target=_blank to the system browser — go through the bridge.
            event.preventDefault();
            openBrowserExternal(step.url);
          }}
        >
          {t('settings.cli.installDialog.openDocs')}
          <ArrowRightIcon />
        </a>
      </div>
    );
  }

  if (step.kind === 'navigation') {
    return (
      <div className="error-diagnostic-step">
        <p className="error-diagnostic-step-text">{description}</p>
        {onNavigateToDependencySettings && step.action === 'openDependencySettings' && (
          <button
            type="button"
            className="error-diagnostic-nav-btn"
            onClick={onNavigateToDependencySettings}
          >
            {t('errorDiagnostic.openDependencySettings')}
            <ArrowRightIcon />
          </button>
        )}
      </div>
    );
  }

  if (step.kind === 'action') {
    return (
      <div className="error-diagnostic-step">
        <p className="error-diagnostic-step-text">{description}</p>
        {step.action === 'updateClaudeSdk' && (
          <UpdateClaudeSdkAction
            t={t}
            errorTimestamp={errorTimestamp}
            onNavigateToDependencySettings={onNavigateToDependencySettings}
          />
        )}
      </div>
    );
  }

  return null;
}

export const ErrorDiagnosticCard = memo(function ErrorDiagnosticCard({
  t,
  pattern,
  errorTimestamp,
  onNavigateToDependencySettings,
}: ErrorDiagnosticCardProps) {
  const baseKey = `errorDiagnostic.${pattern.code}`;

  return (
    <div className="error-diagnostic-card">
      <div className="error-diagnostic-header">
        <span className="error-diagnostic-icon">
          <InfoIcon />
        </span>
        <span className="error-diagnostic-title">
          {t(`${baseKey}.title`)}
        </span>
      </div>

      <p className="error-diagnostic-intro">
        {t(`${baseKey}.intro`)}
      </p>

      {pattern.solutions.map((solution) => {
        const solutionKey = `${baseKey}.solutions.${solution.key}`;
        return (
          <div className="error-diagnostic-solution" key={solution.key}>
            <div className="error-diagnostic-solution-header">
              <span className="error-diagnostic-solution-title">
                {t(`${solutionKey}.title`)}
              </span>
              {solution.recommended && (
                <span className="error-diagnostic-recommended-badge">
                  {t('errorDiagnostic.recommended')}
                </span>
              )}
            </div>
            <div className="error-diagnostic-steps">
              {solution.steps.map((step, index) => (
                <StepRenderer
                  key={`${solution.key}-${index}`}
                  step={step}
                  description={t(`${solutionKey}.step${index}`)}
                  t={t}
                  errorTimestamp={errorTimestamp}
                  onNavigateToDependencySettings={onNavigateToDependencySettings}
                />
              ))}
            </div>
          </div>
        );
      })}

      <p className="error-diagnostic-reason">
        {t(`${baseKey}.reason`)}
      </p>
    </div>
  );
});
