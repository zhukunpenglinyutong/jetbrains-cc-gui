import { describe, expect, it } from 'vitest';
import { OPENCODE_MODELS } from './types';
import { ensureSelectedOpenCodeModel, parseOpenCodeModelPayload } from './openCodeModels';

describe('openCodeModels', () => {
  it('parses discovered opencode models from the bridge payload', () => {
    const models = parseOpenCodeModelPayload(JSON.stringify({
      success: true,
      defaultModel: 'anthropic/claude-sonnet-4-5',
      defaultModelSource: 'config',
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

    expect(models).toEqual({
      defaultModel: 'anthropic/claude-sonnet-4-5',
      defaultModelSource: 'config',
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
        },
      ],
    });
  });

  it('falls back to the default opencode model on invalid payloads', () => {
    const invalidResult = parseOpenCodeModelPayload('not-json');
    expect(invalidResult.models).toEqual([]);
    expect(invalidResult.error).toBeDefined();
    expect(invalidResult.error).toContain('is not valid JSON');

    expect(parseOpenCodeModelPayload(JSON.stringify({ success: false }))).toEqual({
      models: OPENCODE_MODELS,
    });
  });

  it('keeps a selected dynamic model visible before discovery completes', () => {
    expect(ensureSelectedOpenCodeModel(OPENCODE_MODELS, 'github-copilot/gpt-5.1')).toEqual([
      ...OPENCODE_MODELS,
      {
        id: 'github-copilot/gpt-5.1',
        label: 'gpt-5.1',
        description: 'github-copilot/gpt-5.1',
      },
    ]);
  });

  it('does not duplicate the opencode default placeholder', () => {
    expect(ensureSelectedOpenCodeModel(OPENCODE_MODELS, 'opencode-default')).toEqual(OPENCODE_MODELS);
  });

  it('applies defaultModel metadata to the opencode default placeholder', () => {
    const result = parseOpenCodeModelPayload(JSON.stringify({
      success: true,
      defaultModel: 'openai/gpt-5.5',
      defaultModelSource: 'last-used',
      models: [
        { id: 'opencode-default', label: 'opencode default' },
        { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
      ],
    }));

    expect(result.defaultModel).toBe('openai/gpt-5.5');
    expect(result.models[0].description).toBe('Uses openai/gpt-5.5 last used in this project.');
  });
});
