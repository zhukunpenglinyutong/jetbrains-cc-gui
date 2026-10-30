/**
 * Tracks the latest Codex status request for each child so rotating batches
 * may finish out of order without accepting a superseded child snapshot.
 * Responses are also gated by session/provider and native task identity.
 */
let latestSentRequestId: string | null = null;
export const CODEX_SUBAGENT_STATUS_SETTLED_EVENT = 'codex-subagent-status-settled';
const latestRequestByAgent = new Map<string, string>();
let taskSessionId: string | null = null;
const nativeTaskIds = new Map<string, string | undefined>();

/** Keep current task identity beside the existing request-order tracker. */
export function trackCodexSubagentTasks(sessionId: string, agents: Array<{ id: string; nativeTaskId?: string }>): void {
  if (taskSessionId !== sessionId) {
    taskSessionId = sessionId;
    nativeTaskIds.clear();
    latestRequestByAgent.clear();
  }
  const currentIds = new Set(agents.map(agent => agent.id));
  for (const id of nativeTaskIds.keys()) {
    if (!currentIds.has(id)) {
      nativeTaskIds.delete(id);
      latestRequestByAgent.delete(id);
    }
  }
  for (const agent of agents) nativeTaskIds.set(agent.id, agent.nativeTaskId);
}

/** Late reads from a previous task cannot replace the current child's report. */
export function isCurrentCodexSubagentTask(result: { sessionId?: string; toolUseId?: string; nativeTaskId?: string }): boolean {
  if (result.sessionId !== taskSessionId || !result.toolUseId || !nativeTaskIds.has(result.toolUseId)) return true;
  return nativeTaskIds.get(result.toolUseId) === result.nativeTaskId;
}

export function trackCodexStatusRequest(requestId: string, agentIds?: string[]): void {
  latestSentRequestId = requestId;
  if (agentIds) {
    for (const id of agentIds) latestRequestByAgent.set(id, requestId);
  } else {
    latestRequestByAgent.clear();
  }
}

export function isLatestCodexStatusRequest(requestId: string | undefined, agentId?: string): boolean {
  // Responses without a requestId (older bridge builds) fall back to the
  // session/provider gate alone.
  if (!requestId || !latestSentRequestId) return true;
  // Disjoint rotating batches can finish in either order. Only a newer poll
  // of the same child supersedes its result, not a poll of other children.
  return requestId === (agentId ? latestRequestByAgent.get(agentId) ?? latestSentRequestId : latestSentRequestId);
}
