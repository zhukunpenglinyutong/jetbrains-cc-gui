/** Session swaps transfer frontend ownership only on the matching backend clear. */
interface SessionTransition {
  token: string | null;
  targetSessionId: string | null;
  phase: 'preparing' | 'accepted';
  commit: (() => void) | null;
  completion: (() => void) | null;
  retryable: boolean;
  acknowledged: boolean;
}

let transition: SessionTransition | null = null;
const retiredTokens = new Set<string>();
const listeners = new Set<() => void>();

export const getSessionTransitionPending = (): boolean => transition !== null;
export const getSessionTransitionToken = (): string | null => transition?.token ?? null;
export const isSessionTransitionPreparing = (): boolean => transition?.phase === 'preparing';
export const isSessionTransitionRetryable = (): boolean => transition?.retryable === true;
export const isSessionTransitionAcknowledged = (): boolean => transition?.acknowledged === true;
export const isRetiredSessionTransitionToken = (token: string): boolean => retiredTokens.has(token);

function retireCurrentToken(): void {
  if (!transition?.token) return;
  retireSessionTransitionToken(transition.token);
}

export function retireSessionTransitionToken(token: string): void {
  retiredTokens.add(token);
  if (retiredTokens.size > 128) retiredTokens.delete(retiredTokens.values().next().value!);
}

export function subscribeSessionTransition(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function prepareSessionTransition(nextSessionId: string | null, onCommit: () => void, token?: string | null): void {
  if (transition?.token !== (token ?? null)) retireCurrentToken();
  transition = { token: token ?? null, targetSessionId: nextSessionId, phase: 'preparing', commit: onCommit, completion: null,
    retryable: false, acknowledged: token?.startsWith('backend:') === true };
  for (const listener of listeners) listener();
}

export function acknowledgeSessionTransition(token: string): void {
  if (transition?.token === token) transition.acknowledged = true;
}

/** Tokened late replies are rejected even after their transaction has finished. */
export function isCurrentSessionTransitionCallback(token?: string): boolean {
  return (token || null) === (transition?.token ?? null);
}

/** A timeout is not proof of failure; only an explicit replacement may supersede it. */
export function markSessionTransitionTimedOut(token?: string): boolean {
  if (!transition || !isCurrentSessionTransitionCallback(token)) return false;
  transition.retryable = true;
  return true;
}

/** Identity is data, never an acknowledgement that cleanup/acceptance succeeded. */
export function isExpectedSessionTransitionId(sessionId: string | null): boolean {
  if (!transition) return true;
  return transition.phase === 'accepted' && (sessionId || null) === transition.targetSessionId;
}

export function commitPendingSessionTransition(token?: string): boolean {
  if (!isCurrentSessionTransitionCallback(token) || transition?.phase !== 'preparing') return false;
  const apply = transition.commit;
  transition.commit = null;
  transition.phase = 'accepted';
  transition.acknowledged = true;
  apply?.();
  return true;
}

/** A completion that overtakes clear cannot commit or release the wrong view. */
export function deferSessionTransitionCompletion(token: string | undefined, complete: () => void): boolean {
  if (!isCurrentSessionTransitionCallback(token)) return true;
  if (transition?.phase !== 'preparing') return false;
  transition.completion = complete;
  return true;
}

/** Called at the end of clearMessages, after all reset effects are installed. */
export function flushSessionTransitionCompletion(): void {
  if (transition?.phase !== 'accepted') return;
  const complete = transition.completion;
  transition.completion = null;
  complete?.();
}

/** Internal cleanup; external callbacks must check their token before calling. */
export function finishSessionTransition(): void {
  const changed = transition !== null;
  retireCurrentToken();
  transition = null;
  if (changed) for (const listener of listeners) listener();
}
