import { useTranslation } from 'react-i18next';
import type { CodexPlanItem } from '../hooks/useCodexPlanState';

interface CodexPlanActionsProps {
  plan: CodexPlanItem | null;
  executionPending: boolean;
  onExecute: () => void;
  onContinue: () => void;
}

/** Shows explicit actions for a completed native plan item. */
export function CodexPlanActions({
  plan,
  executionPending,
  onExecute,
  onContinue,
}: CodexPlanActionsProps) {
  const { t } = useTranslation();
  if (!plan?.authoritative || !plan.text) return null;
  return (
    <div className="codex-plan-actions" role="region" aria-label={t('codex.plan.title', 'Codex plan')}>
      <div className="codex-plan-actions__summary">
        <strong>{t('codex.plan.ready', 'Plan ready')}</strong>
        <span>{plan.text}</span>
      </div>
      <div className="codex-plan-actions__buttons">
        <button type="button" onClick={onExecute} disabled={executionPending}>
          {executionPending
            ? t('codex.plan.executing', 'Executing…')
            : t('codex.plan.execute', 'Execute plan')}
        </button>
        <button type="button" onClick={onContinue} disabled={executionPending}>
          {t('codex.plan.adjust', 'Continue adjusting')}
        </button>
      </div>
    </div>
  );
}

