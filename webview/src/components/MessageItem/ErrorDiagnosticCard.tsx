import { memo, useState, useCallback } from 'react';
import type { TFunction } from 'i18next';
import type { DiagnosticPattern, DiagnosticStep } from '../../utils/errorMatcher';
import { copyToClipboard } from '../../utils/copyUtils';

interface ErrorDiagnosticCardProps {
  t: TFunction;
  pattern: DiagnosticPattern;
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

interface StepRendererProps {
  step: DiagnosticStep;
  description: string;
  t: TFunction;
  onNavigateToDependencySettings?: () => void;
}

function StepRenderer({ step, description, t, onNavigateToDependencySettings }: StepRendererProps) {
  if (step.kind === 'command') {
    return (
      <div className="error-diagnostic-step">
        <p className="error-diagnostic-step-text">{description}</p>
        <CommandBlock command={step.command} t={t} />
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

  return null;
}

export const ErrorDiagnosticCard = memo(function ErrorDiagnosticCard({
  t,
  pattern,
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
