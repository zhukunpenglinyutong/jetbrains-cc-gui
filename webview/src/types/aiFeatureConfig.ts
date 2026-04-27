export type AiFeatureProvider = 'claude' | 'codex';
export type AiFeatureResolutionSource = 'manual' | 'auto' | 'unavailable';

export interface AiFeatureConfig {
  provider: AiFeatureProvider | null;
  effectiveProvider: AiFeatureProvider | null;
  resolutionSource: AiFeatureResolutionSource;
  models: {
    claude: string;
    codex: string;
  };
  availability: {
    claude: boolean;
    codex: boolean;
  };
}

export type CommitAiProvider = AiFeatureProvider;
export type CommitAiResolutionSource = AiFeatureResolutionSource;
export type CommitAiConfig = AiFeatureConfig;

export const DEFAULT_COMMIT_AI_CONFIG: CommitAiConfig = {
  provider: null,
  effectiveProvider: 'codex',
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
