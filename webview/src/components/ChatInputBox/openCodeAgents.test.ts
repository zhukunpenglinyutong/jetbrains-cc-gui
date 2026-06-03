import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  sendBridgeEvent: vi.fn(() => true),
}));

vi.mock('../../utils/bridge', () => bridgeMocks);

import {
  isOpenCodeSelectedAgent,
  mergeOpenCodeAgentGroups,
  parseOpenCodeAgentPayload,
  selectedAgentForProvider,
} from './openCodeAgents';
import {
  preloadOpenCodeAgents,
  resetOpenCodeAgentsState,
} from './providers/openCodeAgentProvider';
import type { SelectedAgent } from './types';

describe('openCodeAgents', () => {
  beforeEach(() => {
    bridgeMocks.sendBridgeEvent.mockClear();
    resetOpenCodeAgentsState();
  });

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
        group: 'opencode-native',
      },
      {
        id: 'opencode:reviewer',
        name: 'reviewer',
        description: 'Review focused agent.',
        prompt: 'opencode:reviewer',
        provider: 'opencode',
        group: 'opencode-native',
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
    const openCodeScopedCustomAgent: SelectedAgent = {
      id: 'opencode-custom:custom-reviewer',
      name: 'Reviewer',
      prompt: 'Review carefully.',
      provider: 'opencode',
      mode: 'custom',
    };

    expect(isOpenCodeSelectedAgent(opencodeAgent)).toBe(true);
    expect(selectedAgentForProvider(opencodeAgent, 'opencode')).toBe(opencodeAgent);
    expect(selectedAgentForProvider(opencodeAgent, 'claude')).toBeNull();
    expect(selectedAgentForProvider(customAgent, 'opencode')).toBeNull();
    expect(selectedAgentForProvider(customAgent, 'claude')).toBe(customAgent);
    expect(isOpenCodeSelectedAgent(openCodeScopedCustomAgent)).toBe(true);
    expect(selectedAgentForProvider(openCodeScopedCustomAgent, 'opencode')).toBe(openCodeScopedCustomAgent);
    expect(selectedAgentForProvider(openCodeScopedCustomAgent, 'claude')).toBeNull();
  });

  it('groups native opencode and custom agents for the opencode picker', () => {
    const grouped = mergeOpenCodeAgentGroups(
      [
        {
          id: 'opencode:build',
          name: 'build',
          prompt: 'opencode:build',
          provider: 'opencode',
        },
      ],
      [
        {
          id: 'custom-reviewer',
          name: 'Reviewer',
          prompt: 'Review carefully.',
          provider: 'custom',
        },
      ]
    );

    expect(grouped.map((agent) => agent.id)).toEqual([
      '__opencode_native_agents__',
      'opencode:build',
      '__opencode_custom_agents__',
      'opencode-custom:custom-reviewer',
    ]);
    expect(grouped[0].kind).toBe('section-header');
    expect(grouped[3]).toMatchObject({
      provider: 'opencode',
      mode: 'custom',
      prompt: 'Review carefully.',
    });
  });

  it('preloads native agents before the agent menu opens', () => {
    preloadOpenCodeAgents();
    preloadOpenCodeAgents();

    expect(bridgeMocks.sendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.sendBridgeEvent).toHaveBeenCalledWith('get_opencode_agents');
  });
});
