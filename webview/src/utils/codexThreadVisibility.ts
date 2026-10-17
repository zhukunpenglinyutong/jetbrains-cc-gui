/** Hide only native guardian sources, including metadata from older rollouts. */
export function isGuardianReviewThread(thread: Record<string, unknown>): boolean {
  if (thread.threadSource === 'guardian_review' || thread.thread_source === 'guardian_review') return true;
  const source = thread.source as { internal?: unknown; subagent?: { other?: unknown }; subAgent?: { other?: unknown } } | undefined;
  return source?.internal === 'guardian' || source?.subagent?.other === 'guardian' || source?.subAgent?.other === 'guardian';
}
