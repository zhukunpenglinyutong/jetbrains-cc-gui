import { memo } from 'react';
import type { SubagentHistoryResponse } from '../../types';

interface SubagentProcessErrorProps {
  history?: SubagentHistoryResponse;
}

const SubagentProcessError = memo(function SubagentProcessError({
  history,
}: SubagentProcessErrorProps) {
  // Codex pending snapshots carry transient "not found yet" text with a
  // running status; those stay hidden. Non-Codex providers (Claude) report
  // real lookup failures the same way ("Subagent log not found"), and
  // those must remain visible.
  if (!history?.error || (history.status !== 'error' && history.provider === 'codex')) {
    return null;
  }
  return <div className="subagent-error">{history.error}</div>;
});

export default SubagentProcessError;
