/** Guardian approvals are internal threads; a user's chosen title is never classification evidence. */
export function isGuardianReviewThread(thread) {
  if (!thread || typeof thread !== 'object') return false;
  if (thread.threadSource === 'guardian_review' || thread.thread_source === 'guardian_review') return true;
  const source = thread.source;
  return source?.internal === 'guardian' || source?.subagent?.other === 'guardian'
    || source?.subAgent?.other === 'guardian';
}
