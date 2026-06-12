export type DiffThemeMode = 'follow' | 'editor' | 'light' | 'soft-dark';

type ResolvedDiffTheme = 'light' | 'dark' | 'soft-dark' | 'codriver';

const DIFF_THEME_KEYS = [
  '--diff-surface',
  '--diff-gutter-bg',
  '--diff-gutter-border',
  '--diff-text',
  '--diff-muted-text',
  '--diff-added-bg',
  '--diff-added-glyph-bg',
  '--diff-added-accent',
  '--diff-deleted-bg',
  '--diff-deleted-glyph-bg',
  '--diff-deleted-accent',
] as const;

export const getStoredDiffTheme = (): DiffThemeMode => {
  const saved = localStorage.getItem('diffTheme');
  if (saved === 'follow' || saved === 'editor' || saved === 'light' || saved === 'soft-dark') {
    return saved;
  }
  return 'follow';
};

const resolveDiffTheme = (
  diffTheme: DiffThemeMode,
  ideTheme: 'light' | 'dark' | null,
): ResolvedDiffTheme => {
  const uiThemeAttr = document.documentElement.getAttribute('data-theme');
  const currentUiTheme: ResolvedDiffTheme = uiThemeAttr === 'light'
    ? 'light'
    : uiThemeAttr === 'codriver'
      ? 'codriver'
      : 'dark';
  if (diffTheme === 'follow') {
    return currentUiTheme;
  }
  if (diffTheme === 'editor') {
    return ideTheme || currentUiTheme;
  }
  return diffTheme;
};

export const applyDiffTheme = (
  diffTheme: DiffThemeMode,
  ideTheme: 'light' | 'dark' | null,
): void => {
  const resolvedDiffTheme = resolveDiffTheme(diffTheme, ideTheme);
  const root = document.documentElement;

  root.setAttribute('data-diff-theme', resolvedDiffTheme);
  localStorage.setItem('diffTheme', diffTheme);

  if (resolvedDiffTheme === 'light') {
    root.style.setProperty('--diff-surface', '#f8fafc');
    root.style.setProperty('--diff-gutter-bg', '#eef2f7');
    root.style.setProperty('--diff-gutter-border', '#d6dee8');
    root.style.setProperty('--diff-text', '#243244');
    root.style.setProperty('--diff-muted-text', '#7a8794');
    root.style.setProperty('--diff-added-bg', '#e8f5e9');
    root.style.setProperty('--diff-added-glyph-bg', '#d8eddb');
    root.style.setProperty('--diff-added-accent', '#2e7d32');
    root.style.setProperty('--diff-deleted-bg', '#fdecea');
    root.style.setProperty('--diff-deleted-glyph-bg', '#f9d7d4');
    root.style.setProperty('--diff-deleted-accent', '#c62828');
    return;
  }

  if (resolvedDiffTheme === 'codriver') {
    root.style.setProperty('--diff-surface', '#0d1117');
    root.style.setProperty('--diff-gutter-bg', '#161b22');
    root.style.setProperty('--diff-gutter-border', '#30363d');
    root.style.setProperty('--diff-text', '#c9d1d9');
    root.style.setProperty('--diff-muted-text', '#6e7681');
    root.style.setProperty('--diff-added-bg', 'rgba(46, 160, 67, 0.15)');
    root.style.setProperty('--diff-added-glyph-bg', 'rgba(46, 160, 67, 0.30)');
    root.style.setProperty('--diff-added-accent', '#3fb950');
    root.style.setProperty('--diff-deleted-bg', 'rgba(248, 81, 73, 0.15)');
    root.style.setProperty('--diff-deleted-glyph-bg', 'rgba(248, 81, 73, 0.30)');
    root.style.setProperty('--diff-deleted-accent', '#f85149');
    return;
  }

  if (resolvedDiffTheme === 'soft-dark') {
    root.style.setProperty('--diff-surface', '#1f2430');
    root.style.setProperty('--diff-gutter-bg', '#272d3a');
    root.style.setProperty('--diff-gutter-border', '#394150');
    root.style.setProperty('--diff-text', '#d7dde8');
    root.style.setProperty('--diff-muted-text', '#7f8a9b');
    root.style.setProperty('--diff-added-bg', 'rgba(63, 185, 80, 0.18)');
    root.style.setProperty('--diff-added-glyph-bg', 'rgba(63, 185, 80, 0.14)');
    root.style.setProperty('--diff-added-accent', '#89d185');
    root.style.setProperty('--diff-deleted-bg', 'rgba(248, 81, 73, 0.18)');
    root.style.setProperty('--diff-deleted-glyph-bg', 'rgba(248, 81, 73, 0.14)');
    root.style.setProperty('--diff-deleted-accent', '#ff8f8a');
    return;
  }

  root.style.setProperty('--diff-surface', '#1e1e1e');
  root.style.setProperty('--diff-gutter-bg', '#252526');
  root.style.setProperty('--diff-gutter-border', '#333333');
  root.style.setProperty('--diff-text', '#cccccc');
  root.style.setProperty('--diff-muted-text', '#666666');
  root.style.setProperty('--diff-added-bg', 'rgba(20, 80, 20, 0.3)');
  root.style.setProperty('--diff-added-glyph-bg', 'rgba(20, 80, 20, 0.2)');
  root.style.setProperty('--diff-added-accent', '#89d185');
  root.style.setProperty('--diff-deleted-bg', 'rgba(80, 20, 20, 0.3)');
  root.style.setProperty('--diff-deleted-glyph-bg', 'rgba(80, 20, 20, 0.2)');
  root.style.setProperty('--diff-deleted-accent', '#ff6b6b');
};

export const clearDiffTheme = (): void => {
  const root = document.documentElement;
  root.removeAttribute('data-diff-theme');
  for (const key of DIFF_THEME_KEYS) {
    root.style.removeProperty(key);
  }
};
