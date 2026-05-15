export type AiFeatureProvider = 'claude' | 'codex';
export type AiFeatureResolutionSource = 'manual' | 'auto' | 'unavailable';

export const DEFAULT_AI_FEATURE_MODELS = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.5',
} as const;

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
export type CommitGenerationMode = 'prompt' | 'skill';
export type CommitLanguageMode =
  | 'auto'
  | 'en'
  | 'zh'
  | 'zh-TW'
  | 'ko'
  | 'ja'
  | 'es'
  | 'fr'
  | 'hi'
  | 'ru'
  | 'pt-BR';

export interface CommitSkillOption {
  ref: string;
  name: string;
  description?: string;
  source?: 'builtin' | 'claude' | 'codex' | string;
  scope?: string;
  path?: string;
  skillPath?: string;
  enabled?: boolean;
  builtin?: boolean;
}

export interface CommitAiConfig extends AiFeatureConfig {
  generationMode?: CommitGenerationMode;
  skillRef?: string;
  language?: CommitLanguageMode;
  availableSkills?: CommitSkillOption[];
}

export const DEFAULT_COMMIT_SKILL_REF = 'builtin:git-commit';

export const DEFAULT_COMMIT_AI_CONFIG: CommitAiConfig = {
  provider: null,
  effectiveProvider: 'codex',
  resolutionSource: 'auto',
  models: {
    claude: DEFAULT_AI_FEATURE_MODELS.claude,
    codex: DEFAULT_AI_FEATURE_MODELS.codex,
  },
  availability: {
    claude: false,
    codex: false,
  },
  generationMode: 'prompt',
  skillRef: DEFAULT_COMMIT_SKILL_REF,
  language: 'auto',
  availableSkills: [],
};
