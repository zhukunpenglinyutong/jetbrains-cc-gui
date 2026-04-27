import type { AiFeatureConfig, AiFeatureProvider, AiFeatureResolutionSource } from './aiFeatureConfig';

export type PromptEnhancerProvider = AiFeatureProvider;
export type PromptEnhancerResolutionSource = AiFeatureResolutionSource;
export interface PromptEnhancerConfig extends AiFeatureConfig {}

export const DEFAULT_PROMPT_ENHANCER_CONFIG: PromptEnhancerConfig = {
  provider: null,
  effectiveProvider: 'claude',
  resolutionSource: 'auto',
  models: {
    claude: 'claude-sonnet-4-6',
    codex: 'gpt-5.5',
  },
  availability: {
    claude: false,
    codex: false,
  },
};
