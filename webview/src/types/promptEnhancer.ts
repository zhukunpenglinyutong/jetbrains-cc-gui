import type { AiFeatureConfig, AiFeatureProvider, AiFeatureResolutionSource } from './aiFeatureConfig';
import { DEFAULT_AI_FEATURE_MODELS } from './aiFeatureConfig';

export type PromptEnhancerProvider = AiFeatureProvider;
export type PromptEnhancerResolutionSource = AiFeatureResolutionSource;
export type PromptEnhancerConfig = AiFeatureConfig;

export const DEFAULT_PROMPT_ENHANCER_CONFIG: PromptEnhancerConfig = {
  provider: null,
  effectiveProvider: 'claude',
  resolutionSource: 'auto',
  models: {
    claude: DEFAULT_AI_FEATURE_MODELS.claude,
    codex: DEFAULT_AI_FEATURE_MODELS.codex,
  },
  availability: {
    claude: false,
    codex: false,
  },
};
