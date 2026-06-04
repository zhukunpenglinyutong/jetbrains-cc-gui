import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import { isSessionTitleUserCandidate } from './useChatComputations';

const makeMessage = (
  type: ClaudeMessage['type'],
  content: string,
  extra?: Partial<ClaudeMessage>,
): ClaudeMessage => ({
  type,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

describe('isSessionTitleUserCandidate', () => {
  it('skips Codex tool_result user messages', () => {
    const toolResult = makeMessage('user', '[tool_result]', {
      raw: {
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'cmd-1', content: 'ok' }],
        },
      } as any,
    });

    expect(isSessionTitleUserCandidate(toolResult)).toBe(false);
  });

  it('accepts real user messages after tool results for title extraction', () => {
    const realUser = makeMessage('user', '测试通讯');

    expect(isSessionTitleUserCandidate(realUser)).toBe(true);
  });

  it('skips non-human user messages marked by backend origin', () => {
    const synthetic = makeMessage('user', '', {
      raw: {
        origin: { kind: 'tool_result' },
        message: { content: [{ type: 'tool_result', tool_use_id: 'cmd-1', content: 'ok' }] },
      } as any,
    });

    expect(isSessionTitleUserCandidate(synthetic)).toBe(false);
  });
});
