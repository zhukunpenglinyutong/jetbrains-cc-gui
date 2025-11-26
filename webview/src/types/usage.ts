export interface UsageData {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

export interface SessionSummary {
  sessionId: string;
  timestamp: number;
  model: string;
  usage: UsageData;
  cost: number;
  summary?: string;
}

export interface DailyUsage {
  date: string;
  sessions: number;
  usage: UsageData;
  cost: number;
  modelsUsed: string[];
}

export interface ModelUsage {
  model: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  sessionCount: number;
}

export interface WeeklyComparison {
  currentWeek: {
    sessions: number;
    cost: number;
    tokens: number;
  };
  lastWeek: {
    sessions: number;
    cost: number;
    tokens: number;
  };
  trends: {
    sessions: number;
    cost: number;
    tokens: number;
  };
}

export interface ProjectStatistics {
  projectPath: string;
  projectName: string;
  totalSessions: number;
  totalUsage: UsageData;
  estimatedCost: number;
  sessions: SessionSummary[];
  dailyUsage: DailyUsage[];
  weeklyComparison: WeeklyComparison;
  byModel: ModelUsage[];
  lastUpdated: number;
}
