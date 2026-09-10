import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const COLOR_MAP: Record<string, string> = {
  promptBorder: '#7c6ff7',
  inactive: '#6b7280',
  cyanForSubagents: '#22d3ee',
  permission: '#10b981',
  claude: '#d97706',
  warning: '#f59e0b',
  purpleForSubagents: '#a78bfa',
  text: '#e5e7eb',
  success: '#22c55e',
  error: '#ef4444',
};

export function resolveColor(key: string): string {
  if (COLOR_MAP[key]) return COLOR_MAP[key];
  if (key.startsWith('#')) return key;
  return '#6b7280';
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function useTranslateCategoryName() {
  const { t } = useTranslation();

  return useCallback((name: string) => {
    const keyMap: Record<string, string> = {
      'System prompt': 'contextUsage.categories.systemPrompt',
      'System tools': 'contextUsage.categories.systemTools',
      'MCP tools': 'contextUsage.categories.mcpTools',
      'Custom agents': 'contextUsage.categories.customAgents',
      'Memory files': 'contextUsage.categories.memoryFiles',
      'Skills': 'contextUsage.categories.skills',
      'Messages': 'contextUsage.categories.messages',
      'Autocompact buffer': 'contextUsage.categories.autoCompactBuffer',
      'Free space': 'contextUsage.categories.freeSpace',
    };

    const translationKey = keyMap[name];
    if (!translationKey) {
      return name;
    }

    return t(translationKey, { defaultValue: name });
  }, [t]);
}
