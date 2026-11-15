import { useEffect, useMemo, useRef } from 'react';
import type { SubagentInfo } from '../types';
import { sendBridgeEvent } from '../utils/bridge';
import { CODEX_SUBAGENT_STATUS_SETTLED_EVENT, trackCodexStatusRequest, trackCodexSubagentTasks } from '../utils/codexStatusRequestTracker';

const STATUS_POLL_INTERVAL_MS = 2_000;
export const MAX_CODEX_SUBAGENT_STATUS_TARGETS = 64;
// Longer than the host's bounded status read. This only releases an observation
// request when its callback is lost; it never stops native child tasks.
export const CODEX_SUBAGENT_STATUS_TIMEOUT_MS = 15_000;

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
  const batchCursorRef = useRef({ sessionId: currentSessionId, offset: 0 });
  const pendingRequestRef = useRef<{ requestId: string; startedAt: number } | null>(null);
  const agentsJson = useMemo(() => JSON.stringify(
    subagents
      .filter((subagent) => subagent.isAsync && subagent.status === 'running')
      .map((subagent) => ({
        toolUseId: subagent.id,
        agentId: subagent.agentId,
        agentPath: subagent.agentPath,
        nativeTaskId: subagent.nativeTaskId,
        nativeTaskPreviousTurnId: subagent.nativeTaskPreviousTurnId,
      })),
  ), [subagents]);
  const tasksJson = useMemo(() => JSON.stringify(subagents.map(agent => ({ id: agent.id, nativeTaskId: agent.nativeTaskId }))), [subagents]);

  useEffect(() => {
    if (currentProvider !== 'codex' || !currentSessionId) {
      pendingRequestRef.current = null;
      batchCursorRef.current = { sessionId: null, offset: 0 };
      return;
    }
    if (batchCursorRef.current.sessionId !== currentSessionId) {
      batchCursorRef.current = { sessionId: currentSessionId, offset: 0 };
      pendingRequestRef.current = null;
    }
    trackCodexSubagentTasks(currentSessionId, JSON.parse(tasksJson) as Array<{ id: string; nativeTaskId?: string }>);

    const agents = JSON.parse(agentsJson) as Array<{
      toolUseId: string;
      agentId?: string;
      agentPath?: string;
      nativeTaskId?: string;
      nativeTaskPreviousTurnId?: string;
    }>;
    const requestStatuses = () => {
      if (agents.length === 0) return;
      const pending = pendingRequestRef.current;
      if (pending && Date.now() - pending.startedAt < CODEX_SUBAGENT_STATUS_TIMEOUT_MS) return;
      requestSequenceRef.current += 1;
      const requestId = `${currentSessionId}:${requestSequenceRef.current}`;
      const offset = batchCursorRef.current.offset % agents.length;
      const batch = agents.slice(offset, offset + MAX_CODEX_SUBAGENT_STATUS_TARGETS);
      batchCursorRef.current.offset = (offset + batch.length) % agents.length;
      trackCodexStatusRequest(requestId, batch.map(agent => agent.toolUseId));
      pendingRequestRef.current = { requestId, startedAt: Date.now() };
      const sent = sendBridgeEvent('load_subagent_statuses', JSON.stringify({
        sessionId: currentSessionId,
        provider: currentProvider,
        requestId,
        agents: batch,
      }));
      if (sent === false) pendingRequestRef.current = null;
    };

    const onSettled = (event: Event) => {
      const result = (event as CustomEvent<{ requestId?: string; sessionId?: string; provider?: string }>).detail;
      if (result?.sessionId === currentSessionId && result.provider === 'codex'
          && result.requestId === pendingRequestRef.current?.requestId) {
        pendingRequestRef.current = null;
      }
    };
    window.addEventListener(CODEX_SUBAGENT_STATUS_SETTLED_EVENT, onSettled);
    requestStatuses();
    const timer = agents.length ? window.setInterval(requestStatuses, STATUS_POLL_INTERVAL_MS) : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener(CODEX_SUBAGENT_STATUS_SETTLED_EVENT, onSettled);
    };
  }, [agentsJson, tasksJson, currentProvider, currentSessionId]);
}
