import { describe, expect, it } from 'vitest';
import {
  isOpenCodeSelectedAgent,
  parseOpenCodeAgentPayload,
  selectedAgentForProvider,
} from './openCodeAgents';
import type { SelectedAgent } from './types';

describe('openCodeAgents', () => {
  it('parses discovered opencode agents from the bridge payload', () => {
    const agents = parseOpenCodeAgentPayload(JSON.stringify({
      success: true,
      agents: [
        {
          id: 'opencode-default',
          name: 'opencode default',
          description: 'Uses reviewer from opencode config.',
        },
        {
          id: 'opencode:reviewer',
          name: 'reviewer',
          description: 'Review focused agent.',
          agentID: 'reviewer',
          mode: 'all',
          prompt: 'opencode:reviewer',
        },
      ],
    }));

    expect(agents).toEqual([
      {
        id: 'opencode-default',
        name: 'opencode default',
        description: 'Uses reviewer from opencode config.',
        provider: 'opencode',
      },
      {
        id: 'opencode:reviewer',
        name: 'reviewer',
        description: 'Review focused agent.',
        prompt: 'opencode:reviewer',
        provider: 'opencode',
        mode: 'all',
        agentID: 'reviewer',
      },
    ]);
  });

  it('falls back to default opencode agents on invalid payloads', () => {
    expect(parseOpenCodeAgentPayload('not-json').map((agent) => agent.id)).toEqual([
      'opencode-default',
      'opencode:build',
      'opencode:plan',
    ]);
  });

  it('keeps opencode agent selection scoped to opencode provider', () => {
    const opencodeAgent: SelectedAgent = {
      id: 'opencode:plan',
      name: 'plan',
      prompt: 'opencode:plan',
      provider: 'opencode',
    };
    const customAgent: SelectedAgent = {
      id: 'custom-reviewer',
      name: 'Reviewer',
      prompt: 'Review carefully.',
    };

    expect(isOpenCodeSelectedAgent(opencodeAgent)).toBe(true);
    expect(selectedAgentForProvider(opencodeAgent, 'opencode')).toBe(opencodeAgent);
    expect(selectedAgentForProvider(opencodeAgent, 'claude')).toBeNull();
    expect(selectedAgentForProvider(customAgent, 'opencode')).toBeNull();
    expect(selectedAgentForProvider(customAgent, 'claude')).toBe(customAgent);
  });
});
