export type IdeThemeMode = 'light' | 'dark';

export type UiThemeMode = IdeThemeMode | 'system' | 'github-copilot';

export function isUiThemeMode(value: string | null): value is UiThemeMode {
  return value === 'light'
    || value === 'dark'
    || value === 'system'
    || value === 'github-copilot';
}

export function isExplicitUiThemeMode(value: string | null): value is Exclude<UiThemeMode, 'system'> {
  return value === 'light'
    || value === 'dark'
    || value === 'github-copilot';
}

export function resolveThemeAttribute(
  preference: UiThemeMode,
  ideTheme: IdeThemeMode | null,
): IdeThemeMode | 'github-copilot' | null {
  if (preference === 'system') {
    return ideTheme;
  }

  return preference;
}
