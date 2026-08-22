import { useEffect, useMemo, useRef } from 'react';
import type { SubagentInfo } from '../types';
import { sendBridgeEvent } from '../utils/bridge';
import { trackCodexStatusRequest } from '../utils/codexStatusRequestTracker';

const STATUS_POLL_INTERVAL_MS = 2_000;
export const MAX_CODEX_SUBAGENT_STATUS_TARGETS = 64;

interface UseCodexSubagentStatusPollingParams {
  subagents: SubagentInfo[];
  currentSessionId: string | null;
  currentProvider: string;
}

export function useCodexSubagentStatusPolling({
  subagents,
  currentSessionId,
  currentProvider,
}: UseCodexSubagentStatusPollingParams): void {
  const requestSequenceRef = useRef(0);
  const agentsJson = useMemo(() => JSON.stringify(
    subagents
      .filter((subagent) => subagent.isAsync && subagent.status === 'running')
      .slice(0, MAX_CODEX_SUBAGENT_STATUS_TARGETS)
      .map((subagent) => ({
        toolUseId: subagent.id,
        agentId: subagent.agentId,
        agentPath: subagent.agentPath,
      })),
  ), [subagents]);

  useEffect(() => {
    if (currentProvider !== 'codex' || !currentSessionId) return;

    const agents = JSON.parse(agentsJson) as Array<{
      toolUseId: string;
      agentId?: string;
      agentPath?: string;
    }>;
    if (agents.length === 0) return;

    const requestStatuses = () => {
      requestSequenceRef.current += 1;
      const requestId = `${currentSessionId}:${requestSequenceRef.current}`;
      trackCodexStatusRequest(requestId);
      sendBridgeEvent('load_subagent_statuses', JSON.stringify({
        sessionId: currentSessionId,
        provider: currentProvider,
        requestId,
        agents,
      }));
    };

    requestStatuses();
    const timer = window.setInterval(requestStatuses, STATUS_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [agentsJson, currentProvider, currentSessionId]);
}
