/**
 * Tracks the most recently sent Codex subagent status request so late or
 * out-of-order poll responses can be discarded before merging. Responses are
 * already gated by sessionId/provider (isCurrentSubagentResponse); this adds
 * the third leg promised by the protocol: a response is only merged when it
 * answers the latest request the frontend actually sent.
 */
let latestSentRequestId: string | null = null;
let taskSessionId: string | null = null;
const nativeTaskIds = new Map<string, string | undefined>();

/** Keep current task identity beside the existing request-order tracker. */
export function trackCodexSubagentTasks(sessionId: string, agents: Array<{ id: string; nativeTaskId?: string }>): void {
  if (taskSessionId !== sessionId) {
    taskSessionId = sessionId;
    nativeTaskIds.clear();
  }
  for (const agent of agents) nativeTaskIds.set(agent.id, agent.nativeTaskId);
}

/** Late reads from a previous task cannot replace the current child's report. */
export function isCurrentCodexSubagentTask(result: { sessionId?: string; toolUseId?: string; nativeTaskId?: string }): boolean {
  if (result.sessionId !== taskSessionId || !result.toolUseId || !nativeTaskIds.has(result.toolUseId)) return true;
  return nativeTaskIds.get(result.toolUseId) === result.nativeTaskId;
}

export function trackCodexStatusRequest(requestId: string): void {
  latestSentRequestId = requestId;
}

export function isLatestCodexStatusRequest(requestId: string | undefined): boolean {
  // Responses without a requestId (older bridge builds) fall back to the
  // session/provider gate alone.
  if (!requestId || !latestSentRequestId) return true;
  return requestId === latestSentRequestId;
}
