import { CREATE_NEW_AGENT_ID, EMPTY_STATE_ID, type AgentItem } from './providers/agentProvider';
import type { SelectedAgent } from './types';

export const OPENCODE_DEFAULT_AGENT_ID = 'opencode-default';
export const OPENCODE_AGENT_PREFIX = 'opencode:';
export const OPENCODE_CUSTOM_AGENT_PREFIX = 'opencode-custom:';

const OPENCODE_NATIVE_GROUP_ID = '__opencode_native_agents__';
const OPENCODE_CUSTOM_GROUP_ID = '__opencode_custom_agents__';

const FALLBACK_OPENCODE_AGENTS: AgentItem[] = [
  {
    id: OPENCODE_DEFAULT_AGENT_ID,
    name: 'opencode default',
    description: 'Uses the default agent configured in opencode.',
    provider: 'opencode',
    mode: 'primary',
    group: 'opencode-native',
  },
  {
    id: `${OPENCODE_AGENT_PREFIX}build`,
    name: 'build',
    description: 'The default agent. Executes tools based on configured permissions.',
    prompt: `${OPENCODE_AGENT_PREFIX}build`,
    provider: 'opencode',
    mode: 'primary',
    agentID: 'build',
    group: 'opencode-native',
  },
  {
    id: `${OPENCODE_AGENT_PREFIX}plan`,
    name: 'plan',
    description: 'Plan mode. Disallows all edit tools.',
    prompt: `${OPENCODE_AGENT_PREFIX}plan`,
    provider: 'opencode',
    mode: 'primary',
    agentID: 'plan',
    group: 'opencode-native',
  },
];

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalizeOpenCodeAgent(raw: unknown): AgentItem | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const id = asNonEmptyString(candidate.id);
  const name = asNonEmptyString(candidate.name) ?? asNonEmptyString(candidate.label);
  if (!id || !name) {
    return null;
  }

  const agentID = asNonEmptyString(candidate.agentID);
  const description = asNonEmptyString(candidate.description);
  const prompt = asNonEmptyString(candidate.prompt)
    ?? (agentID ? `${OPENCODE_AGENT_PREFIX}${agentID}` : undefined);
  const mode = asNonEmptyString(candidate.mode);

  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    provider: 'opencode',
    ...(mode ? { mode } : {}),
    ...(agentID ? { agentID } : {}),
    group: 'opencode-native',
  };
}

export function parseOpenCodeAgentPayload(payload: string): AgentItem[] {
  try {
    const parsed = JSON.parse(payload);
    const rawAgents: unknown[] = Array.isArray(parsed?.agents) ? parsed.agents : [];
    const agents = rawAgents
      .map(normalizeOpenCodeAgent)
      .filter((agent: AgentItem | null): agent is AgentItem => agent !== null);
    return agents.length > 0 ? agents : FALLBACK_OPENCODE_AGENTS;
  } catch {
    return FALLBACK_OPENCODE_AGENTS;
  }
}

export function isOpenCodeSelectedAgent(agent?: SelectedAgent | null): boolean {
  return Boolean(
    agent &&
      (
        agent.provider === 'opencode' ||
        agent.id.startsWith(OPENCODE_AGENT_PREFIX) ||
        agent.id === OPENCODE_DEFAULT_AGENT_ID ||
        agent.prompt?.startsWith(OPENCODE_AGENT_PREFIX)
      )
  );
}

function groupHeader(id: string, name: string): AgentItem {
  return {
    id,
    name,
    provider: 'opencode',
    kind: 'section-header',
  };
}

function isSelectableAgent(agent: AgentItem): boolean {
  return agent.kind !== 'section-header' && agent.id !== EMPTY_STATE_ID;
}

function toOpenCodeScopedCustomAgent(agent: AgentItem): AgentItem | null {
  if (agent.kind === 'section-header' || agent.id === EMPTY_STATE_ID) {
    return null;
  }

  if (agent.id === CREATE_NEW_AGENT_ID) {
    return {
      ...agent,
      provider: 'opencode',
      group: 'codemoss-custom',
    };
  }

  const prompt = asNonEmptyString(agent.prompt);
  if (!prompt) {
    return null;
  }

  const id = agent.id.startsWith(OPENCODE_CUSTOM_AGENT_PREFIX)
    ? agent.id
    : `${OPENCODE_CUSTOM_AGENT_PREFIX}${agent.id}`;

  return {
    ...agent,
    id,
    prompt,
    provider: 'opencode',
    mode: 'custom',
    group: 'codemoss-custom',
  };
}

export function mergeOpenCodeAgentGroups(nativeAgents: AgentItem[], customAgents: AgentItem[]): AgentItem[] {
  const nativeItems = nativeAgents.map((agent) => ({
    ...agent,
    provider: 'opencode' as const,
    group: 'opencode-native' as const,
  }));
  const customItems = customAgents
    .map(toOpenCodeScopedCustomAgent)
    .filter((agent: AgentItem | null): agent is AgentItem => agent !== null);

  const result: AgentItem[] = [];
  if (nativeItems.length > 0) {
    result.push(groupHeader(OPENCODE_NATIVE_GROUP_ID, 'OpenCode agents'), ...nativeItems);
  }
  if (customItems.length > 0) {
    result.push(groupHeader(OPENCODE_CUSTOM_GROUP_ID, 'Custom agents'), ...customItems);
  }

  return result.length > 0
    ? result
    : [{
      id: EMPTY_STATE_ID,
      name: 'No agents found',
      provider: 'opencode',
    }];
}

export function selectedAgentForProvider(
  agent: SelectedAgent | null | undefined,
  provider: string
): SelectedAgent | null {
  if (!agent) {
    return null;
  }
  const isOpenCodeAgent = isOpenCodeSelectedAgent(agent);
  if (provider === 'opencode') {
    return isOpenCodeAgent ? agent : null;
  }
  return isOpenCodeAgent ? null : agent;
}

export function hasSelectableOpenCodeAgents(agents: AgentItem[]): boolean {
  return agents.some(isSelectableAgent);
}
