export type AiFeatureProvider = 'claude' | 'codex' | 'opencode';
export type AiFeatureResolutionSource = 'manual' | 'auto' | 'unavailable';

export const DEFAULT_AI_FEATURE_MODELS = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.5',
  opencode: 'opencode-default',
} as const;

export interface AiFeatureConfig {
  provider: AiFeatureProvider | null;
  effectiveProvider: AiFeatureProvider | null;
  resolutionSource: AiFeatureResolutionSource;
  models: {
    claude: string;
    codex: string;
    opencode?: string;
  };
  availability: {
    claude: boolean;
    codex: boolean;
    opencode?: boolean;
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
    claude: DEFAULT_AI_FEATURE_MODELS.claude,
    codex: DEFAULT_AI_FEATURE_MODELS.codex,
    opencode: DEFAULT_AI_FEATURE_MODELS.opencode,
  },
  availability: {
    claude: false,
    codex: false,
    opencode: false,
  },
};
