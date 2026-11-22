import { memo } from 'react';
import type { SubagentHistoryResponse } from '../../types';

interface SubagentProcessErrorProps {
  history?: SubagentHistoryResponse;
}

const SubagentProcessError = memo(function SubagentProcessError({
  history,
}: SubagentProcessErrorProps) {
  // Codex and Gemini pending snapshots carry transient "not found yet" text
  // with a running status; those stay hidden. Claude lookup failures
  // ("Subagent log not found") remain visible even while status is running.
  if (!history?.error || (history.status !== 'error' && (history.provider === 'codex' || history.provider === 'gemini'))) {
    return null;
  }
  return <div className="subagent-error">{history.error}</div>;
});

export default SubagentProcessError;
