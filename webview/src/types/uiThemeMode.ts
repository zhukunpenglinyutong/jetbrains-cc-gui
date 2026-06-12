export type IdeThemeMode = 'light' | 'dark';

export type UiThemeMode = IdeThemeMode | 'system' | 'codriver';

export function isUiThemeMode(value: string | null): value is UiThemeMode {
  return value === 'light'
    || value === 'dark'
    || value === 'system'
    || value === 'codriver';
}

export function isExplicitUiThemeMode(value: string | null): value is Exclude<UiThemeMode, 'system'> {
  return value === 'light'
    || value === 'dark'
    || value === 'codriver';
}

export function resolveThemeAttribute(
  preference: UiThemeMode,
  ideTheme: IdeThemeMode | null,
): IdeThemeMode | 'codriver' | null {
  if (preference === 'system') {
    return ideTheme;
  }

  return preference;
}
