import { describe, expect, it } from 'vitest';
import { isGuardianReviewThread } from './codexThreadVisibility';

describe('guardian sources', () => {
  it.each([
    { threadSource: 'guardian_review' }, { thread_source: 'guardian_review' },
    { source: { internal: 'guardian' } }, { source: { subagent: { other: 'guardian' } } },
    { source: { subAgent: { other: 'guardian' } } },
  ])('recognizes explicit metadata %j', thread => expect(isGuardianReviewThread(thread)).toBe(true));
  it.each([{ name: 'Guardian review', source: 'exec' }, { source: { subagent: 'review' } }, {}])
    ('leaves human conversations visible %j', thread => expect(isGuardianReviewThread(thread)).toBe(false));
});
