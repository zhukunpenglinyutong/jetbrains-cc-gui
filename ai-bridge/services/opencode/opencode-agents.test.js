import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOpenCodeAgents,
  resolveOpenCodePromptOptions
} from './message-service.js';

test('opencode agent discovery keeps CLI default placeholder first', () => {
  const agents = normalizeOpenCodeAgents([
    {
      name: 'plan',
      description: 'Plan mode. Disallows all edit tools.',
      mode: 'primary',
      builtIn: true,
    },
    {
      name: 'reviewer',
      description: 'Review focused agent.',
      mode: 'all',
    },
    {
      name: 'explore',
      description: 'Subagent should not be in primary selector.',
      mode: 'subagent',
    },
    {
      name: 'summary',
      description: 'Hidden agent should not be in primary selector.',
      mode: 'primary',
      hidden: true,
    },
  ], {
    default_agent: 'reviewer',
  });

  assert.equal(agents[0].id, 'opencode-default');
  assert.equal(agents[0].description, 'Uses reviewer from opencode config.');
  assert.deepEqual(agents.map((agent) => agent.id), [
    'opencode-default',
    'opencode:plan',
    'opencode:reviewer',
    'opencode:build',
  ]);
  assert.equal(agents.find((agent) => agent.id === 'opencode:reviewer')?.isDefault, true);
});

test('opencode agent discovery falls back to built-in primary agents', () => {
  assert.deepEqual(normalizeOpenCodeAgents().map((agent) => agent.id), [
    'opencode-default',
    'opencode:build',
    'opencode:plan',
  ]);
});

test('opencode prompt routing uses native plan agent for plan mode', () => {
  assert.deepEqual(resolveOpenCodePromptOptions('plan', 'opencode:build'), {
    agent: 'plan',
  });
});

test('opencode prompt routing maps selected opencode agents to body.agent', () => {
  assert.deepEqual(resolveOpenCodePromptOptions('default', 'opencode:reviewer'), {
    agent: 'reviewer',
  });
  assert.deepEqual(resolveOpenCodePromptOptions('default', 'opencode-default'), {});
});

test('opencode prompt routing preserves custom prompts as system text', () => {
  assert.deepEqual(resolveOpenCodePromptOptions('default', 'Use terse review style.'), {
    system: 'Use terse review style.',
  });
});
