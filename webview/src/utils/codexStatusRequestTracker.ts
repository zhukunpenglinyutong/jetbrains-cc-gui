/**
 * Tracks the most recently sent Codex subagent status request so late or
 * out-of-order poll responses can be discarded before merging. Responses are
 * already gated by sessionId/provider (isCurrentSubagentResponse); this adds
 * the third leg promised by the protocol: a response is only merged when it
 * answers the latest request the frontend actually sent.
 */
let latestSentRequestId: string | null = null;

export function trackCodexStatusRequest(requestId: string): void {
  latestSentRequestId = requestId;
}

export function isLatestCodexStatusRequest(requestId: string | undefined): boolean {
  // Responses without a requestId (older bridge builds) fall back to the
  // session/provider gate alone.
  if (!requestId || !latestSentRequestId) return true;
  return requestId === latestSentRequestId;
}
