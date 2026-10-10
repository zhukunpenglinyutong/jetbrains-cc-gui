import type { HookEditorTarget, HookItem, HookProvider, HookScope } from '../../../types/hooks';

export const PROVIDER_ORDER: HookProvider[] = ['codex', 'claude', 'codemoss'];

export const PROVIDER_LABELS: Record<HookProvider, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  codemoss: 'Codemoss',
};

const SCOPE_KEYS: Record<HookScope, string> = {
  GLOBAL: 'settings.hooks.global',
  GLOBAL_LOCAL: 'settings.hooks.globalLocal',
  PROJECT: 'settings.hooks.project',
  PROJECT_LOCAL: 'settings.hooks.projectLocal',
};

export function scopeLabel(scope: HookScope, translate: (key: string) => string): string {
  return translate(SCOPE_KEYS[scope]);
}

export function issueLabel(issue: string, translate: (key: string) => string): string {
  const key = `settings.hooks.issues.${issue}`;
  const translated = translate(key);
  return translated === key ? issue : translated;
}

export function formatTimestamp(value: number | null | undefined): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

export function isHookItem(target: HookEditorTarget): target is HookItem {
  return 'sourceId' in target;
}

export function targetLocation(target: HookEditorTarget): string {
  return isHookItem(target) ? target.rawLocation : target.location;
}

export function matchesHookQuery(item: HookItem, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    PROVIDER_LABELS[item.provider],
    item.event,
    item.matcher,
    item.command,
    item.rawLocation,
  ].some((value) => value?.toLocaleLowerCase().includes(normalized));
}
