import { describe, expect, it } from 'vitest';
import { OPENCODE_MODELS } from './types';
import { ensureSelectedOpenCodeModel, parseOpenCodeModelPayload } from './openCodeModels';

describe('openCodeModels', () => {
  it('parses discovered opencode models from the bridge payload', () => {
    const models = parseOpenCodeModelPayload(JSON.stringify({
      success: true,
      models: [
        {
          id: 'opencode-default',
          label: 'opencode default',
          description: 'Uses anthropic/claude-sonnet-4-5 from opencode config.',
        },
        {
          id: 'anthropic/claude-sonnet-4-5',
          label: 'Claude Sonnet 4.5',
          description: 'Anthropic · provider default',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
      ],
    }));

    expect(models).toEqual([
      {
        id: 'opencode-default',
        label: 'opencode default',
        description: 'Uses anthropic/claude-sonnet-4-5 from opencode config.',
      },
      {
        id: 'anthropic/claude-sonnet-4-5',
        label: 'Claude Sonnet 4.5',
        description: 'Anthropic · provider default',
      },
    ]);
  });

  it('falls back to the default opencode model on invalid payloads', () => {
    expect(parseOpenCodeModelPayload('not-json')).toEqual(OPENCODE_MODELS);
    expect(parseOpenCodeModelPayload(JSON.stringify({ success: false }))).toEqual(OPENCODE_MODELS);
  });

  it('keeps a selected dynamic model visible before discovery completes', () => {
    expect(ensureSelectedOpenCodeModel(OPENCODE_MODELS, 'github-copilot/gpt-5.1')).toEqual([
      ...OPENCODE_MODELS,
      {
        id: 'github-copilot/gpt-5.1',
        label: 'github-copilot/gpt-5.1',
        description: 'Selected opencode model',
      },
    ]);
  });

  it('does not duplicate the opencode default placeholder', () => {
    expect(ensureSelectedOpenCodeModel(OPENCODE_MODELS, 'opencode-default')).toEqual(OPENCODE_MODELS);
  });
});
